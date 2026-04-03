# Onboarding detection

Host clicks "+" button --> payout info check --> initialize onboarding for hosts with no payout info

```

    [Host Clicks "+" Button]
            ↓
    [Check Payout Info]
        ┌─────────────┬──────────────┐
        │             │              │
    [Exists]       [Missing]      [Error]
        │             ↓              ↓
    [Continue Flow] [Initialize Onboarding] -> [End]

```

# Onboarding flow

stripe onboarding --> render success page --> save payoutInfo after successful onboarding

```

    [Stripe Onboarding Initiated]
            ↓
    [Host Fills Payout Info]
            ↓
    [Onboarding Success?]
        ┌─────────────┬──────────────┐
        │             │              │
    [Success]     [Failure]       [Error]
        │             ↓              ↓
    [Render Success] [Retry Onboarding] -> [End]
            ↓
    [Save Payout Info] -> [End]

```

# Promotion flow

hit api --> checkout --> create payment and promotion --> on checkout success update payment and promotion

```

    [API Call: Initiate Promotion]
            ↓
    [Create Checkout Session]
            ↓
    [Payment Created?]
        ┌─────────────┬──────────────┐
        │             │              │
    [Success]     [Failure]       [Error]
        │             ↓              ↓
    [Save Payment/Promo] [Retry Process] -> [End]
            ↓
    [On Checkout Success]
            ↓
    [Update Payment & Promo] -> [End]


```

# user payment flow

user pay --> platform gets 5% and business gets 95% --> stripe deducts fees from business --> payout to bank each 7 days

```

    [User Pays]
            ↓
    [Payment Processed]
            ↓
    [Platform Fee Deduction]
        ┌─────────────┬──────────────┐
        │             │              │
    [5% Platform] [95% Business]  [Error]
        │             ↓              ↓
    [Stripe Deducts Fee from Business] -> [End]
            ↓
    [Payout to Bank (7 Days)] -> [End]

```
