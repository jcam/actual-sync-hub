# SimpleFIN

## Official docs

- [SimpleFIN Bridge home](https://beta-bridge.simplefin.org/)
- [SimpleFIN Bridge developer guide](https://beta-bridge.simplefin.org/info/developers)
- [SimpleFIN protocol specification](https://www.simplefin.org/protocol.html)

## Best hobbyist mode for real bank data

For a hobbyist or self-hosted Actual deployment, the simplest live mode is the hosted SimpleFIN Bridge.

Why:

- it is priced like a flat consumer subscription
- it is explicitly built around a user-generated setup token flow
- it is a much better personal self-hosting fit than most business-first aggregation products

## Approximate cost for a hobbyist deployment

As of May 11, 2026, the hosted Bridge shows:

- `$1.50/month`, or
- `$15.00/year`

The hosted Bridge price covers up to 25 institutions and 25 apps.

SimpleFIN does not use a pay-as-you-go pricing model here; it is a flat subscription.

Practical hobbyist estimate:

- `5` linked institutions: about `$1.50/month`
- `10` linked institutions: about `$1.50/month`

Important caveat:

- this is a flat user subscription, not a per-account or per-API-call price
- for a handful of institutions with regular sync, that flat rate can be cheaper than business-oriented pay-as-you-go aggregators

## Important gotchas

- SimpleFIN is the opposite of Plaid or Teller operationally: it is hobbyist-friendly on price, but the connect model is intentionally simple and manual.
- There is no provider dashboard with reusable app credentials for end-user links. The user must generate a setup token, and reconnects are fundamentally token-driven rather than webhook-driven.
- That simplicity is usually a feature for self-hosting, but it also means less automation around reconnect and provider-side diagnostics.

## Where to get credentials or access

There is no developer dashboard key like Plaid or Stripe.

Instead:

1. the user goes to the Bridge and generates a one-time setup token
2. the app exchanges that setup token for a durable access URL / access key

In this repo:

- the web UI accepts the setup token directly
- the live-test `.env` stores the resulting access key

## Best hobbyist advice

- Use the hosted Bridge if your goal is low-cost personal transaction sync.
- Treat this repo's `sandbox` mode as development-only.
- If you are using a different SimpleFIN-compatible bridge, switch the provider to `development` mode in the UI and set the server URL there.

## Development and test mode

For this repo:

- `sandbox` is fine for app-level development
- the live integration test path uses a real claimed access key

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:simplefin
```

The script lets you either:

- paste a setup token and let the script exchange it, or
- paste an existing access key

Typical output:

```dotenv
SIMPLEFIN_TEST_RUN_LIVE=1
SIMPLEFIN_TEST_ACCESS_KEY=https://username:password@bridge.example.com/simplefin
SIMPLEFIN_TEST_ACCOUNT_ID=
```

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the SimpleFIN page and use the setup-token connect box.
