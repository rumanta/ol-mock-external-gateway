import "dotenv/config";

import crypto from "node:crypto";
import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();

const port = Number(process.env.PORT || 5678);
const jwksUrl = process.env.OPENLEARNING_JWKS_URL || "https://qa.openlearning.com/.well-known/jwks.json/";
const defaultRedirectUrl = process.env.DEFAULT_REDIRECT_URL || "https://qa.openlearning.com/";
const dryRun = String(process.env.DRY_RUN || "true").toLowerCase() !== "false";

const jwks = createRemoteJWKSet(new URL(jwksUrl));
const paymentContexts = new Map();
const enrolmentContentType = "application/json; charset=utf-8";

class PaymentPayloadError extends Error {}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ol-mock-external-gateway",
    dryRun,
    jwksUrl,
    port
  });
});

app.get("/payment/start", handlePaymentStart);
app.post("/payment/start", handlePaymentStart);
app.post("/payment/success", handlePaymentSuccess);
app.post("/payment/cancel", handlePaymentCancel);

async function handlePaymentStart(req, res) {
  try {
    const token = extractToken(req);

    if (!token) {
      return renderError(
        res,
        400,
        "Missing payment details",
        "The payment link did not include the signed payment details from OpenLearning."
      );
    }

    const payload = await verifyOpenLearningJwt(token);
    const context = normalizePaymentContext(payload);
    const contextId = crypto.randomUUID();

    paymentContexts.set(contextId, {
      context,
      payload,
      createdAt: new Date().toISOString()
    });

    res.status(200).send(renderPaymentPage(contextId, context, payload));
  } catch (error) {
    console.error("Could not verify payment request:", error);

    if (error instanceof PaymentPayloadError) {
      return renderError(
        res,
        400,
        "Payment details are incomplete",
        error.message
      );
    }

    renderError(
      res,
      401,
      "Payment details could not be checked",
      "OpenLearning sent payment details, but this mock gateway could not confirm they came from QA. Please check the verification URL and try again."
    );
  }
}

async function handlePaymentSuccess(req, res) {
  const contextId = req.body.contextId;
  const stored = paymentContexts.get(contextId);

  if (!stored) {
    return renderError(res, 404, "Payment session expired", "Please restart the enrolment flow from OpenLearning QA.");
  }

  const { context } = stored;

  try {
    const enrolmentResult = dryRun
      ? {
          dryRun: true,
          message: "Practice mode is on. The learner was not enrolled.",
          request: buildOutgoingEnrolmentRequest(context)
        }
      : await callAsyncEngineEnrolmentApi(context);

    paymentContexts.delete(contextId);
    res.status(200).send(renderSuccessPage(context, enrolmentResult));
  } catch (error) {
    res.status(502).send(renderFailurePage(context, error));
  }
}

function handlePaymentCancel(req, res) {
  const contextId = req.body.contextId;
  const stored = paymentContexts.get(contextId);

  if (contextId) {
    paymentContexts.delete(contextId);
  }

  const redirectUrl = stored?.context?.redirectUrl || defaultRedirectUrl;
  res.redirect(303, redirectUrl);
}

function extractToken(req) {
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice("bearer ".length)
    : "";

  return (
    req.body?.jwt ||
    req.body?.token ||
    req.body?.id_token ||
    req.query?.jwt ||
    req.query?.token ||
    req.query?.id_token ||
    req.headers["x-ol-token"] ||
    req.headers["x-gateway-token"] ||
    bearerToken ||
    ""
  );
}

async function verifyOpenLearningJwt(token) {
  const verifyOptions = {
    algorithms: ["EdDSA", "RS256"]
  };

  if (process.env.EXPECTED_AUDIENCE) {
    verifyOptions.audience = process.env.EXPECTED_AUDIENCE;
  }

  const { payload } = await jwtVerify(token, jwks, verifyOptions);
  return payload;
}

function normalizePaymentContext(payload) {
  const isProgram = Boolean(payload.program);
  const isCourse = Boolean(payload.course || payload.class);

  if (!payload.sub) {
    throw new PaymentPayloadError("OpenLearning did not include the learner id in the payment details.");
  }

  if (isProgram && isCourse) {
    throw new PaymentPayloadError("OpenLearning sent both program and course details. Please restart with one enrolment item.");
  }

  if (!isProgram && !isCourse) {
    throw new PaymentPayloadError("OpenLearning did not include a program, course, or class id in the payment details.");
  }

  return {
    type: isProgram ? "program" : "course",
    transactionId: stringOrEmpty(payload.jti),
    learnerUserId: stringOrEmpty(payload.sub),
    audience: stringOrEmpty(payload.aud),
    title: stringOrEmpty(payload.title),
    programId: stringOrEmpty(payload.program),
    courseId: stringOrEmpty(payload.course),
    cohortId: stringOrEmpty(payload.class),
    currency: stringOrEmpty(payload.currency),
    price: stringOrEmpty(payload.price),
    accessCode: stringOrEmpty(payload.access_code),
    redirectUrl: stringOrEmpty(payload.redirect_url) || defaultRedirectUrl
  };
}

function buildEnrolmentPayload(context) {
  if (context.type === "program") {
    return {
      user: context.learnerUserId
    };
  }

  return {
    user: context.learnerUserId,
    course: context.courseId || undefined,
    class: context.cohortId || undefined,
    send_welcome_email: true,
    ignore_course_prereqs: false
  };
}

function buildOutgoingEnrolmentRequest(context) {
  return {
    method: "POST",
    url: getEnrolmentUrl(context) || "Not configured",
    contentType: enrolmentContentType,
    payload: buildEnrolmentPayload(context)
  };
}

async function callAsyncEngineEnrolmentApi(context) {
  const url = getEnrolmentUrl(context);
  const requestPayload = buildEnrolmentPayload(context);
  const outgoingRequest = buildOutgoingEnrolmentRequest(context);

  if (!url) {
    throw new Error("The OpenLearning enrolment service URL is not set yet. Add the QA enrolment service URL in .env, then try again.");
  }

  const headers = {
    "Content-Type": enrolmentContentType
  };

  const authHeaderName = process.env.ASYNC_ENGINE_AUTH_HEADER_NAME;
  const authHeaderValue = process.env.ASYNC_ENGINE_AUTH_HEADER_VALUE;

  if (authHeaderName && authHeaderValue) {
    headers[authHeaderName] = authHeaderValue;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestPayload)
  });

  const responseText = await response.text();
  let responseBody = responseText;

  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    // Keep non-JSON responses as text for debugging.
  }

  if (!response.ok) {
    const routeHint = context.type === "program" && response.status === 404
      ? " The QA enrolment service may not have program enrolment enabled yet."
      : "";

    throw new Error([
      `OpenLearning could not enrol the learner. Status ${response.status}: ${responseText}`,
      routeHint,
      "",
      `Tried: ${url}`,
      `Content-Type: ${enrolmentContentType}`,
      `Sent: ${JSON.stringify(requestPayload)}`
    ].join("\n"));
  }

  return {
    status: response.status,
    request: outgoingRequest,
    body: responseBody
  };
}

function itemTypeLabel(context) {
  return context.type === "program" ? "Program" : "Course";
}

function itemTypeLowerLabel(context) {
  return context.type === "program" ? "program" : "course";
}

function getEnrolmentUrl(context) {
  const overrideUrl = context.type === "program"
    ? process.env.ASYNC_ENGINE_PROGRAM_ENROL_URL
    : process.env.ASYNC_ENGINE_COURSE_ENROL_URL;

  if (overrideUrl) {
    return overrideUrl;
  }

  const baseUrl = stripTrailingSlash(process.env.OPENLEARNING_API_BASE_URL || "");
  if (!baseUrl) {
    return "";
  }

  if (context.type === "program") {
    return `${baseUrl}/institutions/${encodeURIComponent(context.audience)}/programs/${encodeURIComponent(context.programId)}/enrolments/`;
  }

  return `${baseUrl}/enrolments/submit-json/`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function stringOrEmpty(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function escapeHtml(value) {
  return stringOrEmpty(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLayout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #17212b;
      background: #f5f7f8;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
    }
    main {
      width: min(720px, 100%);
      background: #fff;
      border: 1px solid #dbe2e8;
      border-radius: 8px;
      box-shadow: 0 16px 48px rgba(23, 33, 43, 0.12);
      padding: 28px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
      line-height: 1.2;
    }
    p {
      margin: 8px 0;
      color: #53606b;
      line-height: 1.5;
    }
    dl {
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 12px 18px;
      margin: 24px 0;
    }
    dt {
      color: #53606b;
      font-weight: 600;
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 24px;
    }
    button, a.button {
      border: 0;
      border-radius: 6px;
      padding: 12px 18px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    button:disabled {
      cursor: wait;
      opacity: 0.72;
    }
    .primary {
      background: #00384a;
      color: #fff;
    }
    .secondary {
      background: #e8edf1;
      color: #17212b;
    }
    pre {
      background: #f0f3f5;
      border-radius: 6px;
      overflow: auto;
      padding: 14px;
      font-size: 13px;
      line-height: 1.45;
    }
    .notice {
      background: #fff7df;
      border: 1px solid #f0c75e;
      border-radius: 6px;
      padding: 12px 14px;
      color: #533f00;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border: 3px solid rgba(255, 255, 255, 0.45);
      border-top-color: #fff;
      border-radius: 50%;
      display: none;
      flex: 0 0 auto;
      animation: spin 0.8s linear infinite;
    }
    .is-loading .spinner {
      display: inline-block;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (max-width: 640px) {
      body {
        padding: 16px;
      }
      main {
        padding: 20px;
      }
      dl {
        grid-template-columns: 1fr;
        gap: 6px;
      }
    }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
  <script>
    document.querySelectorAll("[data-submit-once]").forEach((form) => {
      form.addEventListener("submit", () => {
        document.querySelectorAll("button").forEach((button) => {
          button.disabled = true;
        });

        const button = form.querySelector("button[type='submit']");
        const label = button?.querySelector("[data-loading-label]");

        if (button) {
          button.classList.add("is-loading");
          button.setAttribute("aria-busy", "true");
        }

        if (label) {
          label.textContent = label.dataset.loadingLabel || "Processing payment...";
        }
      });
    });
  </script>
</body>
</html>`;
}

function renderPaymentPage(contextId, context, payload) {
  const price = context.price && context.currency
    ? `${escapeHtml(context.currency)} ${escapeHtml(context.price)}`
    : "No price supplied";
  const itemLabel = itemTypeLabel(context);

  return renderLayout("Mock Payment Page", `
    <h1>Mock Payment Page</h1>
    <p>This is the payment provider step. Review the enrolment details, then simulate a successful payment.</p>
    ${dryRun ? '<p class="notice">Practice mode is on. The learner will not be enrolled yet.</p>' : ""}
    <dl>
      <dt>What they are joining</dt><dd>${itemLabel}</dd>
      <dt>Learner</dt><dd>${escapeHtml(context.learnerUserId)}</dd>
      <dt>Portal</dt><dd>${escapeHtml(context.audience)}</dd>
      <dt>Name</dt><dd>${escapeHtml(context.title)}</dd>
      <dt>Price</dt><dd>${price}</dd>
      ${context.type === "program" ? `<dt>Program ID</dt><dd>${escapeHtml(context.programId)}</dd>` : ""}
      ${context.type === "course" ? `<dt>Course ID</dt><dd>${escapeHtml(context.courseId || "Not supplied")}</dd>` : ""}
      ${context.type === "course" ? `<dt>Class ID</dt><dd>${escapeHtml(context.cohortId || "Not supplied")}</dd>` : ""}
      ${context.type === "course" ? `<dt>Access code</dt><dd>${escapeHtml(context.accessCode || "Not supplied")}</dd>` : ""}
    </dl>
    <p>Decoded payment details:</p>
    <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    <p>Outgoing enrolment request:</p>
    <pre>${escapeHtml(JSON.stringify(buildOutgoingEnrolmentRequest(context), null, 2))}</pre>
    <div class="actions">
      <form method="post" action="/payment/success" data-submit-once>
        <input type="hidden" name="contextId" value="${escapeHtml(contextId)}">
        <button class="primary" type="submit">
          <span class="spinner" aria-hidden="true"></span>
          <span data-loading-label="Processing payment...">Simulate successful payment</span>
        </button>
      </form>
      <form method="post" action="/payment/cancel">
        <input type="hidden" name="contextId" value="${escapeHtml(contextId)}">
        <button class="secondary" type="submit">Cancel</button>
      </form>
    </div>
  `);
}

function renderSuccessPage(context, enrolmentResult) {
  const isPracticeMode = Boolean(enrolmentResult?.dryRun);
  const title = isPracticeMode ? "Practice payment complete" : "Payment accepted";
  const enrolmentMessage = isPracticeMode
    ? "In a real payment, this learner would now be enrolled. Practice mode is on, so no enrolment was made."
    : `The payment was accepted and the learner has been enrolled in the ${itemTypeLowerLabel(context)}.`;
  const itemLabel = itemTypeLabel(context);

  return renderLayout(title, `
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(enrolmentMessage)}</p>
    <dl>
      <dt>Learner</dt><dd>${escapeHtml(context.learnerUserId)}</dd>
      <dt>${itemLabel}</dt><dd>${escapeHtml(context.title)}</dd>
      <dt>Price</dt><dd>${escapeHtml(context.currency)} ${escapeHtml(context.price)}</dd>
    </dl>
    <p>Behind-the-scenes details:</p>
    <pre>${escapeHtml(JSON.stringify(enrolmentResult, null, 2))}</pre>
    <div class="actions">
      <a class="button primary" href="${escapeHtml(context.redirectUrl)}">Return to OpenLearning</a>
    </div>
  `);
}

function renderFailurePage(context, error) {
  const itemLowerLabel = itemTypeLowerLabel(context);

  return renderLayout("Learner was not enrolled", `
    <h1>Learner was not enrolled</h1>
    <p>The payment was simulated, but OpenLearning could not enrol the learner in the ${itemLowerLabel}.</p>
    <p>Behind-the-scenes details:</p>
    <pre>${escapeHtml(error.message)}</pre>
    <div class="actions">
      <a class="button secondary" href="${escapeHtml(context.redirectUrl)}">Return to OpenLearning</a>
    </div>
  `);
}

function renderError(res, status, title, detail) {
  res.status(status).send(renderLayout(title, `
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  `));
}

app.listen(port, () => {
  console.log(`Mock external gateway listening on http://localhost:${port}`);
  console.log(`Dry run: ${dryRun ? "on" : "off"}`);
  console.log(`JWKS: ${jwksUrl}`);
});
