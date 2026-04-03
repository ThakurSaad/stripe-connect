# Stripe Connect Payment Flow

This document explains how Stripe Connect is implemented in the system, covering the complete payment flow between User, Host, and Admin.

This is the draft right now for the ongoing development, and there is a significant number of improvements needed in the code

## Roles

* **User**: Makes payments for bookings
* **Host**: Provides the service (event or track) and receives payouts
* **Admin (Platform)**: Collects a platform fee from each transaction

## 1. Host Onboarding (Stripe Account Connection)

Before a host can receive payments, they must complete Stripe onboarding.

### Flow:

The system creates a Stripe Express account:

```javascript
stripe.accounts.create({
  country: "GB",
  type: "express",
  capabilities: {
    card_payments: { requested: true },
    transfers: { requested: true },
  },
});
```

An onboarding link is generated using:

```javascript
stripe.accountLinks.create(...)
```

The host is redirected to Stripe to:
* Provide bank details
* Complete identity verification

After successful onboarding, Stripe redirects back to the platform.

The system stores:
* `stripe_account_id`
* Bank account metadata (last 4 digits, routing number)

This information is saved in the `PayoutInfo` collection and is used later during payments.

## 2. Booking Payment Flow (User → Host + Platform)

When a user makes a booking, the system creates a Stripe Checkout session and handles revenue splitting.

### Step 1: Booking Validation
* Ensures the booking exists
* Determines whether it is an event or track booking
* Retrieves the associated host

### Step 2: Retrieve Host Payout Info

The system fetches the host’s Stripe account:

```javascript
PayoutInfo.findOne({ host: booking.host })
```

This provides the `stripe_account_id` required for transferring funds.

### Step 3: Fee Calculation

The system calculates:

* **Platform fee**: 5% of booking amount
* **Stripe fee**: 2.9% of total (shared between platform and host)

```javascript
platformFee = amount * 0.05
payableAmount = amount + platformFee

stripeFee = payableAmount * 0.029
halfStripeFee = stripeFee / 2

platformAmount = platformFee - halfStripeFee
hostAmount = amount - halfStripeFee
```

### Step 4: Create Stripe Checkout Session

A Stripe Checkout session is created with embedded Connect logic:

```javascript
payment_intent_data: {
  application_fee_amount: platformAmount,
  transfer_data: {
    destination: payoutInfo.stripe_account_id,
  },
  on_behalf_of: payoutInfo.stripe_account_id,
}
```

**Explanation:**
1. The user pays via Stripe Checkout
2. Stripe automatically splits the payment:
   * The host receives their share in their connected Stripe account
   * The platform receives the application fee

This is implemented using Stripe Connect "destination charges".

### Step 5: Store Payment Record

Before redirecting the user, a payment record is created:

```javascript
Payment.create({
  checkout_session_id,
  user,
  host,
  amount,
  currency,
  ...
})
```

This allows tracking and reconciliation after payment completion.

### Step 6: Redirect to Stripe

The user is redirected to the Stripe-hosted payment page:

```javascript
return session.url;
```

## 3. Webhook Handling (Payment Confirmation)

Stripe sends a webhook event after payment completion.

**Event handled:**
`checkout.session.completed`

### Flow:

1. **Verify webhook signature**
   ```javascript
   stripe.webhooks.constructEvent(...)
   ```

2. **Update payment status**
   ```javascript
   Payment.findOneAndUpdate(
     { checkout_session_id: id },
     {
       payment_intent_id: payment_intent,
       status: 'SUCCEEDED',
     }
   )
   ```

3. **Update related entities**
   * **For bookings:**
     * Mark booking(s) as `PAID`
     * Retrieve booking details
     * Send confirmation email to the user
   * **For promotions:**
     * Mark promotion as `PAID`

## 4. Promotion Payments

Promotion payments follow a simpler flow:

* A fixed amount is charged via Stripe Checkout
* No Connect transfer is involved
* The full amount goes to the platform

Payment and promotion records are created and later updated via webhook.

## 5. Payout Information Storage

After onboarding, the system stores payout details using:

```javascript
stripe.accounts.listExternalAccounts(...)
```

**Stored data includes:**

* Stripe account ID
* Bank account last 4 digits
* Routing number

This ensures future payments can be routed correctly.

## 6. Cleanup of Unpaid Records

A scheduled cron job runs daily to remove unpaid payment records:

```javascript
Payment.deleteMany({
  status: 'UNPAID'
})
```

## Summary
* Hosts connect their Stripe accounts via Stripe Express onboarding
* Users pay through Stripe Checkout
* Stripe automatically splits payments between host and platform
* The platform takes a 5% fee
* Payment status is confirmed via webhooks
* Bookings and promotions are updated accordingly

This implementation uses Stripe Connect destination charges, allowing automated and secure fund distribution without manual payout handling.
