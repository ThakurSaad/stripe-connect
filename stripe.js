const { default: status } = require("http-status");
const cron = require("node-cron");
const config = require("../../../config");
const ApiError = require("../../../error/ApiError");
const { errorLogger } = require("../../../shared/logger");
const validateFields = require("../../../util/validateFields");
const {
  ENUM_BUSINESS_TYPE,
  ENUM_PAYMENT_STATUS,
  ENUM_PROMOTION_STATUS,
  ENUM_BOOKING_STATUS,
} = require("../../../util/enum");
const Event = require("../event/event.model");
const Track = require("../track/track.model");
const Booking = require("../booking/booking.model");
const Payment = require("./payment.model");
const Promotion = require("../../promotion/Promotion");
const PayoutInfo = require("./PayoutInfo");
const EmailHelpers = require("../../../util/emailHelpers");
const catchAsync = require("../../../shared/catchAsync");
const { response } = require("express");

const stripe = require("stripe")(config.stripe.secret_key);
const endPointSecret = config.stripe.end_point_secret;

const onboarding = async (userData) => {
  const payoutInfo = await PayoutInfo.findOne({ host: userData.userId });

  if (payoutInfo)
    throw new ApiError(status.CONFLICT, "Already completed stripe onboarding");

  const accountData = {
    country: "GB",
    type: "express",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  };
  const account = await stripe.accounts.create(accountData);

  const accountLinkData = {
    account: account.id,
    refresh_url: `http://${config.base_url}:${config.port}/payment/reauth`,
    return_url: `http://${config.base_url}:${config.port}/payment/return?connectedAccountId=${account.id}&hostId=${userData.userId}`,
    type: "account_onboarding",
  };
  const accountLink = await stripe.accountLinks.create(accountLinkData);

  return {
    accountLink,
  };
};

const createCheckoutForBooking = async (userData, payload) => {
  /**
   * Creates a Stripe checkout session for booking payments.
   *
   * This function is responsible for processing payments when a user books an event or track slot.
   * It validates the provided booking details, calculates the necessary fees, and creates a Stripe
   * checkout session with the appropriate payment details.
   *
   * Functionality:
   * - Validates required fields in the payload.
   * - Ensures only one of `bookingId` or `bookingIds` is provided.
   * - Retrieves the booking details and verifies its existence.
   * - Fetches payout information and validates the associated business (event or track).
   * - Calculates platform fees, Stripe fees, and the final payable amount.
   * - Creates a Stripe checkout session with relevant payment details and payout information.
   * - Saves payment details in the database.
   * - Returns the Stripe checkout session URL for the frontend to redirect the user for payment.
   *
   * Usage:
   * - This function is triggered when a user attempts to pay for a booking.
   * - It ensures the correct amount is charged, platform fees are deducted, and the host receives
   *   their share of the payment.
   * - Provides a secure and structured payment flow via Stripe.
   */

  validateFields(payload, ["amount", "currency"]);

  const { userId } = userData;
  const {
    bookingId: singleBookingId,
    bookingIds,
    amount: prevAmount,
  } = payload || {};

  if (!singleBookingId && !bookingIds)
    throw new ApiError(status.BAD_REQUEST, "Missing bookingId or bookingIds");
  if (singleBookingId && bookingIds)
    throw new ApiError(status.BAD_REQUEST, "Only one: bookingId or bookingIds");

  const bookingId = singleBookingId ? singleBookingId : bookingIds[0];

  const amountInCents = Number(prevAmount) * 100;
  let session = {};

  // const currency = currencyValidator(payload.currency);

  // validate booking
  const booking = await Booking.findById(bookingId)
    .select("user host event eventSlot track trackSlot currency")
    .lean();

  if (!booking) throw new ApiError(status.NOT_FOUND, "Booking not found");

  // validate payoutInfo and business
  const isEventBooking = Boolean(booking.event);
  const Model = isEventBooking ? Event : Track;
  const businessId = isEventBooking ? booking.event : booking.track;
  let [payoutInfo, business] = await Promise.all([
    PayoutInfo.findOne({ host: booking.host }),
    Model.findById(businessId).select("_id").lean(),
  ]);

  if (!payoutInfo) throw new ApiError(status.NOT_FOUND, "PayoutInfo not found");
  if (!business) throw new ApiError(status.NOT_FOUND, "Booking not found");

  const platformFee = amountInCents * 0.05;
  const payableAmount = amountInCents + platformFee;
  const stripeFee = payableAmount * 0.029;
  const halfOfStripeFee = stripeFee / 2;
  const platformAmount = platformFee - halfOfStripeFee;
  const hostAmount = amountInCents - halfOfStripeFee;

  const sessionData = {
    payment_method_types: ["card"],
    mode: "payment",
    // success_url: `http://${config.base_url}:${config.port}/payment/success`,
    // cancel_url: `http://${config.base_url}:${config.port}/payment/cancel`,
    success_url: `https://api.mytrackss.com/payment/success`,
    cancel_url: `https://api.mytrackss.com/payment/cancel`,
    line_items: [
      {
        price_data: {
          currency: payload.currency,
          product_data: {
            name: "Amount",
            description: `Platform Fee: ${platformFee / 100} ${
              payload.currency
            }`,
          },
          unit_amount: Math.round(payableAmount),
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: Math.round(platformAmount),
      transfer_data: {
        destination: payoutInfo.stripe_account_id,
      },
      on_behalf_of: payoutInfo.stripe_account_id,
    },
  };

  try {
    session = await stripe.checkout.sessions.create(sessionData);
  } catch (error) {
    console.log(error);
    errorLogger.error(error.message);
    throw new ApiError(status.BAD_REQUEST, error.message);
  }

  const { id: checkout_session_id, url } = session || {};

  const paymentData = {
    ...(isEventBooking && {
      event: businessId,
      eventSlot: booking.eventSlot,
      businessType: ENUM_BUSINESS_TYPE.EVENT,
    }),
    ...(!isEventBooking && {
      bookingId: singleBookingId,
      track: businessId,
      trackSlot: booking.trackSlot,
      businessType: ENUM_BUSINESS_TYPE.TRACK,
    }),
    user: userId,
    host: booking.host,
    amount: prevAmount,
    currency: payload.currency,
    checkout_session_id,
  };

  if (isEventBooking && payload.bookingId)
    paymentData.bookingId = payload.bookingId;
  if (isEventBooking && payload.bookingIds)
    paymentData.bookingIds = payload.bookingIds;

  const payment = await Payment.create(paymentData);

  return url;
};

const createCheckoutForPromotion = async (req) => {
  const { user, body: payload, files } = req;
  const { userId } = user;
  const { trackId } = payload || {};
  let track = {};
  let session = {};

  validateFields(files, ["banner_image"]);
  validateFields(payload, ["trackId", "currency"]);

  // const currency = currencyValidator(payload.currency);

  const sessionData = {
    payment_method_types: ["card"],
    mode: "payment",
    // success_url: `http://${config.base_url}:${config.port}/payment/success`,
    // cancel_url: `http://${config.base_url}:${config.port}/payment/cancel`,
    success_url: `https://api.mytrackss.com/payment/success`,
    cancel_url: `https://api.mytrackss.com/payment/cancel`,
    line_items: [
      {
        price_data: {
          currency: payload.currency,
          product_data: {
            name: "Promoting your track for",
          },
          unit_amount: 20 * 100,
        },
        quantity: 1,
      },
    ],
  };

  try {
    [track, session] = await Promise.all([
      Track.findById(trackId),
      stripe.checkout.sessions.create(sessionData),
    ]);
  } catch (error) {
    console.log(error);
    errorLogger.error(error.message);
  }

  if (!track) throw new ApiError(status.NOT_FOUND, "Business not found");

  const { id: checkout_session_id, url } = session || {};

  const paymentData = {
    host: userId,
    trackId,
    businessType: ENUM_BUSINESS_TYPE.TRACK,
    isPromotion: true,
    amount: 10,
    currency: payload.currency,
    checkout_session_id,
  };
  const promotionData = {
    host: userId,
    track: trackId,
    checkout_session_id,
    banner_image: files.banner_image[0].path,
  };

  await Promise.all([
    Payment.create(paymentData),
    Promotion.create(promotionData),
  ]);

  return url;
};

const webhookManager = async (req) => {
  const sig = req.headers["stripe-signature"];
  console.log("Content-Type:", req.headers["content-type"]);

  let event;
  const date = new Date();

  console.log("webhook hit");

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endPointSecret);
  } catch (error) {
    console.log(error);
    response.status(400).send(`Webhook error: ${error.message}`);
    return;
  }

  switch (event.type) {
    case "checkout.session.completed":
      updatePaymentAndRelatedAndSendMail(event.data.object);
      break;
    default:
      console.log(
        `${date.toDateString()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()} Unhandled event type (${
          event.type
        })`
      );
  }
};

// ** save business payout info after successful onboarding
const savePayoutInfo = async (query) => {
  const { connectedAccountId, hostId } = query;

  const bankAccounts = await stripe.accounts.listExternalAccounts(
    connectedAccountId,
    { object: "bank_account" }
  );

  const payoutData = {
    host: hostId,
    stripe_account_id: connectedAccountId,
    bank_account_no_last4: bankAccounts.data[0].last4,
    routing_no: bankAccounts.data[0].routing_number,
  };

  const payoutInfo = await PayoutInfo.create(payoutData);
};

const getBankAccountDetails = async (connectedAccountId) => {
  const bankAccounts = await stripe.accounts.listExternalAccounts(
    // connectedAccountId,
    "acct_1QiU2yBG91GJM2ry",
    {
      object: "bank_account",
    }
  );
  return bankAccounts;
};

// ** utility function
const updatePaymentAndRelatedAndSendMail = async (webhookEventData) => {
  try {
    const { id, payment_intent } = webhookEventData;
    // const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent);

    const payment = await Payment.findOneAndUpdate(
      { checkout_session_id: id },
      {
        $set: {
          payment_intent_id: payment_intent,
          status: ENUM_PAYMENT_STATUS.SUCCEEDED,
        },
      },
      { new: true }
    );

    // Update booking or promotion details based on the payment type by verifying the payment data stored during the checkout session.
    if (payment.isPromotion) {
      const promotion = await Promotion.findOneAndUpdate(
        {
          checkout_session_id: id,
        },
        { status: ENUM_PROMOTION_STATUS.PAID }
      );
    } else {
      await Booking.updateMany(
        {
          _id: payment.bookingId
            ? payment.bookingId
            : {
                $in: payment.bookingIds,
              },
        },
        {
          status: ENUM_BOOKING_STATUS.PAID,
        },
        { new: true, runValidators: true }
      );

      const updatedBooking = await Booking.findOne({
        _id: payment.bookingId ? payment.bookingId : payment.bookingIds[0],
      }).populate([
        {
          path: "user",
          select: "name email",
        },
        {
          path: "event",
          select: "eventName",
        },
        {
          path: "eventSlot",
          select: "slotNo",
        },
        {
          path: "track",
          select: "trackName",
        },
        {
          path: "trackSlot",
          select: "slotNo",
        },
      ]);

      const emailData = {
        ...(updatedBooking.event && {
          eventName: updatedBooking.event.eventName,
          slotNo: updatedBooking.eventSlot.slotNo,
        }),
        ...(updatedBooking.track && {
          trackName: updatedBooking.track.trackName,
          slotNo: updatedBooking.trackSlot.slotNo,
        }),
        name: updatedBooking.user.name,
        price: updatedBooking.price,
        currency: updatedBooking.currency,
        numOfPeople: updatedBooking.numOfPeople,
        payment_intent_id: payment_intent,
      };

      EmailHelpers.sendBookingEmail(updatedBooking.user.email, emailData);
    }
  } catch (error) {
    console.log(error);
    errorLogger.error(error.message);
  }
};

// Delete unpaid payments and bookings every day at midnight
cron.schedule(
  "0 0 * * *",
  catchAsync(async () => {
    const [, /* bookingDeletionResult */ paymentDeletionResult] =
      await Promise.all([
        // Booking.deleteMany({
        //   status: ENUM_BOOKING_STATUS.UNPAID,
        // }),
        Payment.deleteMany({
          status: ENUM_PAYMENT_STATUS.UNPAID,
        }),
      ]);

    // if (bookingDeletionResult.deletedCount > 0) {
    //   logger.info(
    //     `Deleted ${bookingDeletionResult.deletedCount} unpaid bookings`
    //   );
    // }
    if (paymentDeletionResult.deletedCount > 0) {
      logger.info(
        `Deleted ${paymentDeletionResult.deletedCount} unpaid payments`
      );
    }
  })
);

const StripeService = {
  onboarding,
  createCheckoutForBooking,
  createCheckoutForPromotion,
  webhookManager,
  savePayoutInfo,
  getBankAccountDetails,
};

module.exports = StripeService;
