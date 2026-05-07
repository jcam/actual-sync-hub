# Teller

## Best hobbyist mode for real bank data

For real bank polling, the best hobbyist mode here is **development**.

Why:

- Teller **development** can reach real institutions without you going fully live
- it is a better fit for personal testing than jumping straight to production

Official docs:

- [Teller Quickstart](https://teller.io/docs/guides/quickstart)
- [Teller Authentication](https://teller.io/docs/api/authentication)
- [Teller Environments](https://teller.io/docs/guides/environments)

## Where to get credentials

In the Teller Dashboard:

- **Application Settings** page:
  - copy your `App ID`
- **Certificates** section:
  - download or rotate your client certificate and private key

Important:

- Teller docs say the certificate and private key are created for you when you sign up
- if you lose them, revoke and create a new certificate in the dashboard
- there is no separate public API in this repo for generating those credentials

## Best hobbyist advice

- Use `development` for real personal-bank testing.
- Use `production` only when you actually need live deployment setup.

## Development and test mode

For this repo's development and repeatable tests, the cheapest mode is **sandbox**.

Why:

- Teller Sandbox is free and unlimited for fake data
- it avoids the client-certificate work needed in secure environments
- it is the simplest way to exercise this repo's live sandbox and test helpers

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:teller
```

The script will ask which Teller environment you want:

- `sandbox`
- `development`
- `production`

### Sandbox output

The script writes keys like:

```dotenv
TELLER_TEST_RUN_LIVE=1
TELLER_TEST_ENV=sandbox
TELLER_TEST_APP_ID=your-app-id
TELLER_TEST_SANDBOX_ACCESS_TOKEN=your-sandbox-access-token
```

### Development / production output

The script writes keys like:

```dotenv
TELLER_TEST_RUN_LIVE=1
TELLER_TEST_ENV=development
TELLER_TEST_APP_ID=your-app-id
TELLER_TEST_CERT_FILE=/absolute/path/to/cert.pem
TELLER_TEST_KEY_FILE=/absolute/path/to/key.pem
TELLER_TEST_WEBHOOK_SIGNING_SECRETS=
```

This repo expects **file paths** for Teller cert/key in `.env`, not pasted PEM blocks.

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the Teller page in the UI.
