# Teller

## Official docs

- [Teller environments](https://teller.io/docs/guides/environments)
- [Teller Quickstart](https://teller.io/docs/guides/quickstart)
- [Teller Connect](https://teller.io/docs/guides/connect)
- [Teller webhooks](https://teller.io/docs/api/webhooks)
- [Teller pricing](https://teller.io/)

## Best hobbyist mode for real bank data

For a hobbyist or self-hosted Actual deployment, the best Teller mode is `development`.

Why:

- Teller development uses real bank data
- it is free
- it includes up to 100 enrollments, which is far more than most personal setups need
- it behaves like production for the parts this repo cares about, including mTLS and real institution flows

## Approximate cost for a hobbyist deployment

As of May 11, 2026:

- `sandbox`: free, unlimited simulated data
- `development`: free, up to 100 live enrollments
- `production transactions`: `$0.30` per enrollment per month

Teller does not present this as a flat subscription plan for small users. Once you leave the free development tier, the cost model is usage-shaped around the paid enrollments you keep active.

Practical hobbyist estimate in the cheapest real-data mode:

- `5` linked institutions / enrollments in development: about `$0/month`
- `10` linked institutions / enrollments in development: about `$0/month`

If you later graduate to production transactions pricing and assume one login per institution:

- `5` enrollments: about `$1.50/month`
- `10` enrollments: about `$3.00/month`

Important caveat:

- Teller bills by enrollment, not by individual account
- one enrollment can expose multiple accounts at the same institution
- for a tiny paid deployment, this can still be cheaper than a flat monthly provider plan because you are only paying for the enrollments you keep active

## Important gotchas

- Teller's free `development` tier is a lifetime-created-enrollments limit, not an active-enrollments limit.
- Teller's own docs explicitly say deleting an enrollment does not restore your development enrollment count.
- In practice, that means a hobbyist self-hosted deployment should treat every real-bank Teller enrollment as consuming one of the 100 slots permanently.
- Teller's delete API is authenticated with the enrollment access token itself, not just your app-level dashboard credentials.
- If you lose the stored Teller access token for a live development enrollment, assume that enrollment is effectively stranded for this deployment: you may no longer be able to fetch it, repair it, or explicitly delete it from this app.
- Teller also polls connected institutions on its own schedule for transaction processing. If a stranded enrollment never reaches a disconnected state, Teller may keep attempting to connect to that bank until the enrollment is explicitly removed or otherwise invalidated.

## Where to get credentials

In the Teller Dashboard:

1. open **Application Settings**
2. copy your `Application ID`

For API access in development or production:

1. open **Certificates**
2. download or rotate your client certificate and private key

For webhooks:

1. open **Application Settings**
2. configure your webhook URL
3. copy the webhook signing secret from the same page

## Best hobbyist advice

- Use `development` for real personal-bank testing and small self-hosted use.
- Use `sandbox` only for repeatable fake-data development.
- Move to `production` only when you actually need more than the free development tier.

## Development and test mode

For this repo's repeatable development and automated tests, the easiest mode is `sandbox`.

Why:

- sandbox is free
- no real bank credentials are involved
- this repo has explicit sandbox seed helpers and live sandbox coverage

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:teller
```

The script asks which environment you want:

- `sandbox`
- `development`
- `production`

Typical sandbox output:

```dotenv
TELLER_TEST_RUN_LIVE=1
TELLER_TEST_ENV=sandbox
TELLER_TEST_APP_ID=your-app-id
TELLER_TEST_SANDBOX_ACCESS_TOKEN=your-sandbox-access-token
```

Typical development output:

```dotenv
TELLER_TEST_RUN_LIVE=1
TELLER_TEST_ENV=development
TELLER_TEST_APP_ID=your-app-id
TELLER_TEST_CERT_FILE=/absolute/path/to/cert.pem
TELLER_TEST_KEY_FILE=/absolute/path/to/key.pem
TELLER_TEST_WEBHOOK_SIGNING_SECRETS=
```

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the Teller page in the UI.
