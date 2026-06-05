# OpenLearning Mock External Gateway

A small local mock payment gateway for testing OpenLearning QA external gateway payment flows.

This tool is for OpenLearning teammates who need to test external gateway enrolment without manually copying JWTs from webhook.site, decoding them in jwt.io, and then calling enrolment APIs by hand.

This is a QA/demo tool. It is not a real payment processor and should not be used for production payments.

## Must Read

Read these sections if you only want to get the mock gateway running and test a payment flow.

1. [What This Does](#what-this-does)
2. [Requirements](#requirements)
3. [First-Time Setup](#first-time-setup)
4. [Run The Local Server](#run-the-local-server)
5. [Expose It With ngrok](#expose-it-with-ngrok)
6. [Add The Link In OpenLearning QA](#add-the-link-in-openlearning-qa)
7. [Test A Program Or Course](#test-a-program-or-course)

## Good To Know

Read these sections when you need more detail, debugging help, or implementation context.

1. [Features](#features)
2. [Dry Run Versus Real Enrolment](#dry-run-versus-real-enrolment)
3. [OpenLearning APIs Used](#openlearning-apis-used)
4. [Payment JWT Fields](#payment-jwt-fields)
5. [Local Endpoints](#local-endpoints)
6. [Troubleshooting](#troubleshooting)
7. [Safety Notes](#safety-notes)

## What This Does

The mock gateway acts like a payment provider:

```text
OpenLearning QA
  -> public ngrok URL
  -> this local mock payment gateway
  -> OpenLearning QA enrolment API
  -> learner is enrolled in the program or course/class
```

When a learner clicks enrol in OpenLearning QA, OpenLearning sends signed payment details to this mock gateway. The mock gateway verifies those details, shows a mock payment page, then enrols the learner after you click `Simulate successful payment`.

It supports:

- Program enrolment.
- Course/class enrolment.

## Requirements

You need:

- Node.js 20 or newer.
- npm.
- ngrok CLI.
- An ngrok account and auth token.
- Access to OpenLearning QA.
- Permission to configure an external gateway for the institution/course/program you are testing.
- A QA API key that can enrol learners.

Keep the QA API key private. Put it in `.env` only. Do not paste it into commits, screenshots, or shared channels.

## First-Time Setup

Clone the repository:

```bash
git clone git@github.com:rumanta/ol-mock-external-gateway.git
cd ol-mock-external-gateway
```

Install dependencies:

```bash
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

The repository includes `.env.example` as a fill-in template. Copy it once, then edit `.env` on your machine. Keep `.env.example` committed, but never commit `.env`.

For a first practice run, the important values are:

```env
PORT=5678
OPENLEARNING_JWKS_URL=https://qa.openlearning.com/.well-known/jwks.json/
DRY_RUN=true
DEFAULT_REDIRECT_URL=https://qa.openlearning.com/
```

For a real QA enrolment test, also fill in:

```env
DRY_RUN=false
OPENLEARNING_API_BASE_URL=https://qa-api.openlearning.com/v2.2
ASYNC_ENGINE_AUTH_HEADER_NAME=X-API-Key
ASYNC_ENGINE_AUTH_HEADER_VALUE=<your QA API key>
```

Usually these can stay blank:

```env
ASYNC_ENGINE_PROGRAM_ENROL_URL=
ASYNC_ENGINE_COURSE_ENROL_URL=
```

Use those override values only if you need to send requests to a non-standard endpoint.

## Run The Local Server

Run:

```bash
npm start
```

The default local URL is:

```text
http://localhost:5678
```

Check that it is running:

```bash
curl http://localhost:5678/health
```

The default port is `5678` to avoid common OpenLearning local development ports. If that port is already used, change `PORT` in `.env`.

To quickly check common local ports:

```bash
lsof -iTCP -sTCP:LISTEN -n -P | grep -E ':(3000|3001|5000|5173|5678|8000|8080|9000) '
```

## Expose It With ngrok

In another terminal, run:

```bash
ngrok http 5678
```

ngrok will show a public forwarding URL, for example:

```text
https://example-name.ngrok-free.dev
```

The OpenLearning external gateway Destination URL must be that public URL plus `/payment/start`:

```text
https://example-name.ngrok-free.dev/payment/start
```

Free ngrok URLs usually change when ngrok restarts. If the URL changes, update the Destination URL in OpenLearning QA.

If you have a reserved ngrok domain, start ngrok with the command shown in your ngrok dashboard for that domain. It will look similar to:

```bash
ngrok http --url=<your-reserved-domain> 5678
```

Then use:

```text
https://<your-reserved-domain>/payment/start
```

## Add The Link In OpenLearning QA

In OpenLearning QA:

1. Go to the institution admin area.
2. Open the institution settings.
3. Go to `Integrations`.
4. Open `External Gateway`.
5. Add or edit an external gateway.
6. Set `Destination URL` to your ngrok URL with `/payment/start`.
7. Turn on signed data transfer/JWT.
8. Keep the QA JWKS verification URL as:

```text
https://qa.openlearning.com/.well-known/jwks.json/
```

Then configure the course, class, or program you are testing to use that external gateway as its payment method.

If you cannot see the External Gateway settings, ask someone with institution admin access to configure it.

## Test A Program Or Course

For a program:

1. Set up the external gateway on a QA program payment flow.
2. Log in as a learner.
3. Open the program landing page.
4. Click the program enrol button.
5. Confirm the mock payment page says `Program`.
6. Review the learner, portal, program title, price, decoded JWT JSON, and outgoing enrolment request JSON.
7. Click `Simulate successful payment`.
8. Confirm the success page says the learner has been enrolled in the program.
9. Return to OpenLearning and confirm the learner can access the program.

For a course or class:

1. Set up the external gateway on a QA course/class payment flow.
2. Log in as a learner.
3. Open the course/class enrolment page.
4. Click the enrol/join button.
5. Confirm the mock payment page says `Course`.
6. Review the learner, portal, course title, price, course ID, class ID, decoded JWT JSON, and outgoing enrolment request JSON.
7. Click `Simulate successful payment`.
8. Confirm the success page says the learner has been enrolled in the course.
9. Return to OpenLearning and confirm the learner can access the course/class.

The `access_code` from the JWT is displayed for testers, but it is not sent to the enrolment endpoint. Course/class enrolment uses the `course` and `class` IDs from the signed JWT.

## Features

- Receives OpenLearning external gateway payment requests.
- Verifies the signed JWT using the OpenLearning QA JWKS URL.
- Shows a friendly mock payment page before enrolment is triggered.
- Supports program enrolment.
- Supports course/class enrolment.
- Shows the decoded JWT JSON for debugging.
- Shows the outgoing enrolment request JSON before it is sent.
- Shows the OpenLearning QA API response JSON after enrolment.
- Supports `DRY_RUN=true` so testers can inspect the flow without enrolling anyone.
- Uses ngrok so OpenLearning QA can reach your local machine.
- Disables the payment button and shows a loading spinner after it is clicked, so testers do not submit the same mock payment multiple times.

## Dry Run Versus Real Enrolment

The app defaults to practice mode:

```env
DRY_RUN=true
```

In practice mode, the mock gateway verifies the JWT and shows what it would send, but it does not call OpenLearning QA to enrol the learner.

To make the mock gateway actually enrol learners in QA:

```env
DRY_RUN=false
OPENLEARNING_API_BASE_URL=https://qa-api.openlearning.com/v2.2
ASYNC_ENGINE_AUTH_HEADER_VALUE=<your QA API key>
```

Restart the server after changing `.env`.

## OpenLearning APIs Used

OpenLearning QA API docs:

[https://qa-api.openlearning.com/v2.2/docs](https://qa-api.openlearning.com/v2.2/docs)

Program enrolment:

```text
POST https://qa-api.openlearning.com/v2.2/institutions/{institution_id}/programs/{program_id}/enrolments/
```

Program request body:

```json
{
  "user": "learner_user_id"
}
```

Course/class enrolment:

```text
POST https://qa-api.openlearning.com/v2.2/enrolments/submit-json/
```

Course/class request body:

```json
{
  "user": "learner_user_id",
  "course": "course_id",
  "class": "class_id",
  "send_welcome_email": true,
  "ignore_course_prereqs": false
}
```

The request uses:

```text
Content-Type: application/json; charset=utf-8
```

That content type is intentional. Some OpenLearning routes have legacy JSON handling that can behave differently when the content type is exactly `application/json`.

## Payment JWT Fields

Program payment JWTs are expected to include:

```text
sub, aud, title, program, currency, price, jti, redirect_url
```

Course/class payment JWTs are expected to include:

```text
sub, aud, title, course, class, currency, price, access_code, jti, redirect_url
```

Important fields:

- `sub` is the learner user ID.
- `aud` is the OpenLearning institution/portal identifier.
- `program` is the program ID.
- `course` is the course ID.
- `class` is the class ID.
- `title` is displayed to the tester.
- `redirect_url` is where the `Return to OpenLearning` button sends the learner.

## Local Endpoints

- `GET /health` checks whether the mock gateway is running.
- `GET /payment/start` accepts payment details in the URL for fallback testing.
- `POST /payment/start` receives OpenLearning external gateway requests.
- `POST /payment/success` simulates a successful payment and calls the enrolment endpoint when `DRY_RUN=false`.
- `POST /payment/cancel` cancels the mock payment and redirects back to OpenLearning.

## Troubleshooting

### The ngrok page shows a browser warning

Free ngrok domains may show a one-time browser warning. Click through it for manual testing. Paid or reserved ngrok domains can avoid this, depending on your ngrok setup.

### The page says payment details could not be checked

The JWT could not be verified. Check:

- `OPENLEARNING_JWKS_URL` points to QA.
- The external gateway has signed data transfer/JWT enabled.
- The request came from the same QA environment.
- The token was not copied from an old browser session.

### The learner was not enrolled

Check the behind-the-scenes details on the failure page. It includes:

- The status returned by OpenLearning QA.
- The URL the mock gateway tried.
- The content type.
- The JSON payload sent to OpenLearning QA.

Common causes:

- `DRY_RUN=false` is set but `ASYNC_ENGINE_AUTH_HEADER_VALUE` is missing.
- The QA API key does not have permission to enrol learners for that institution.
- The learner is already enrolled.
- The course, class, program, or institution ID does not exist in QA.
- The endpoint has not been deployed to QA yet.

### Postman returns `405 Method Not Allowed` for program enrolment

If you are manually testing the program enrolment endpoint in Postman, avoid sending exactly:

```text
Content-Type: application/json
```

Use:

```text
Content-Type: application/json; charset=utf-8
```

The mock gateway already does this.

### The port is already in use

Change `PORT` in `.env`, restart the server, then start ngrok with the same port:

```bash
ngrok http <your-port>
```

Update the OpenLearning Destination URL if ngrok gives you a different public URL.

## Safety Notes

- Do not commit `.env`.
- Do not commit API keys.
- Use QA only.
- Use `DRY_RUN=true` when recording demos where you do not want to change enrolments.
- Rotate any API key that was accidentally pasted into a public place.
