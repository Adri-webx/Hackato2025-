// server.js
import express from "express";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { readFileSync } from "fs";
import {
  createAuthenticatedClient,
  OpenPaymentsClientError,
  isFinalizedGrant,
} from "@interledger/open-payments";

config();

const app = express();

// Paths para servir estáticos
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Logs simples de cada request (útil para depurar)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Parseo JSON + handler de error si el body no es JSON válido
app.use(express.json());
app.use((err, _req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({ success: false, error: "JSON inválido en el cuerpo de la petición" });
  }
  next(err);
});

// Sirve tu frontend desde /public (index.html, estilos.css, img/, etc.)
app.use(express.static(path.join(__dirname, "public")));

const {
  PORT = 5500,
  BASE_URL = `http://localhost:5500`,

  // Emisor (quien paga)
  SENDING_WALLET_ADDRESS_URL,
  SENDING_KEY_ID,
  SENDING_PRIVATE_KEY_PATH, // p.ej. ./key/sender_private.key

  // Receptor (quien cobra) - solo URL
  RECEIVING_WALLET_ADDRESS_URL,
} = process.env;

// ---- Cliente autenticado (Emisor) ----
async function makeSenderClient() {
  return createAuthenticatedClient({
    walletAddressUrl: SENDING_WALLET_ADDRESS_URL,
    privateKey: readFileSync(SENDING_PRIVATE_KEY_PATH, "utf8"), // CONTENIDO PEM
    keyId: SENDING_KEY_ID,
  });
}
const sendingClientPromise = makeSenderClient();

// Utils
const toMinor = (amountMajor, scale) =>
  String(Math.round(Number(amountMajor) * Math.pow(10, Number(scale ?? 0))));

// Mapa para el flujo por link (/linkpay -> /pay/callback)
const paySessions = new Map(); // state -> { continueUri, continueAccessToken, quoteId }

// Mapa para el flujo existente basado en /quote + /pago
const pendingGrants = new Map();

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

// ============ FLUJO “PAGO POR LINK” ============
app.get("/linkpay", async (req, res) => {
  try {
    const amountMajor = Number(req.query.amount);
    if (!Number.isFinite(amountMajor) || amountMajor <= 0) {
      return res.status(400).send("Parámetro 'amount' inválido");
    }

    const sendingClient = await sendingClientPromise;

    // Descubrir wallets
    const sendingWalletAddress = await sendingClient.walletAddress.get({
      url: SENDING_WALLET_ADDRESS_URL,
    });
    const receivingWalletAddress = await sendingClient.walletAddress.get({
      url: RECEIVING_WALLET_ADDRESS_URL,
    });

    const assetCode = receivingWalletAddress.assetCode;
    const assetScale = Number(receivingWalletAddress.assetScale ?? 2);

    // 1) Grant (receptor) para crear Incoming Payment
    const ipGrant = await sendingClient.grant.request(
      { url: receivingWalletAddress.authServer },
      {
        access_token: {
          access: [{ type: "incoming-payment", actions: ["read", "create", "complete"] }],
        },
      }
    );

    // 2) Crear Incoming Payment (valor en unidades menores)
    const incomingPayment = await sendingClient.incomingPayment.create(
      {
        url: receivingWalletAddress.resourceServer,
        accessToken: ipGrant.access_token.value,
      },
      {
        walletAddress: receivingWalletAddress.id,
        incomingAmount: {
          assetCode,
          assetScale,
          value: toMinor(amountMajor, assetScale),
        },
        // metadata: { memo: "Compra CBT" }, // opcional
      }
    );

    // 3) Grant (emisor) para crear Quote
    const quoteGrant = await sendingClient.grant.request(
      { url: sendingWalletAddress.authServer },
      { access_token: { access: [{ type: "quote", actions: ["create", "read"] }] } }
    );

    // 4) Crear Quote (para pagar ese incoming)
    const quote = await sendingClient.quote.create(
      {
        url: sendingWalletAddress.resourceServer,
        accessToken: quoteGrant.access_token.value,
      },
      { walletAddress: sendingWalletAddress.id, receiver: incomingPayment.id, method: "ilp" }
    );

    // 5) Grant interactivo (emisor) para Outgoing Payment con finish.redirect
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const finishUri = `${BASE_URL}/pay/callback?state=${encodeURIComponent(state)}`;

    const outgoingPaymentGrant = await sendingClient.grant.request(
      { url: sendingWalletAddress.authServer },
      {
        access_token: {
          access: [
            {
              type: "outgoing-payment",
              actions: ["read", "create"],
              limits: { debitAmount: quote.debitAmount },
              identifier: sendingWalletAddress.id,
            },
          ],
        },
        interact: {
          start: ["redirect"],
          finish: { method: "redirect", uri: finishUri, nonce },
        },
      }
    );

    // Guarda datos para el callback
    paySessions.set(state, {
      continueUri: outgoingPaymentGrant.continue.uri,
      continueAccessToken: outgoingPaymentGrant.continue.access_token.value,
      quoteId: quote.id,
    });

    // 6) Redirige a la Test Wallet para autorizar
    return res.redirect(outgoingPaymentGrant.interact.redirect);
  } catch (err) {
    console.error("/linkpay error:", err);
    return res.status(500).send("No se pudo iniciar el pago.");
  }
});

// Callback desde la wallet tras autorizar
app.get("/pay/callback", async (req, res) => {
  try {
    const { state, interact_ref } = req.query;
    if (!state || !paySessions.has(state)) {
      return res.status(400).send("Sesión de pago no encontrada o expirada.");
    }
    const stash = paySessions.get(state);

    const sendingClient = await sendingClientPromise;

    // 7) Finalizar grant interactivo
    const finalized = await sendingClient.grant.continue(
      { url: stash.continueUri, accessToken: stash.continueAccessToken },
      { interact_ref }
    );

    if (!isFinalizedGrant(finalized)) {
      return res
        .status(400)
        .send("No se pudo finalizar la autorización. ¿Aceptaste el permiso en la wallet?");
    }

    // 8) Crear Outgoing Payment
    const sendingWalletAddress = await sendingClient.walletAddress.get({
      url: SENDING_WALLET_ADDRESS_URL,
    });
    const outgoingPayment = await sendingClient.outgoingPayment.create(
      {
        url: sendingWalletAddress.resourceServer,
        accessToken: finalized.access_token.value,
      },
      { walletAddress: sendingWalletAddress.id, quoteId: stash.quoteId }
    );

    paySessions.delete(state);

    // A) HTML simple de éxito:
    return res.send(`
      <html>
        <head><meta charset="utf-8"><title>Pago completado</title></head>
        <body style="font-family: sans-serif;">
          <h2>✅ Pago enviado</h2>
          <p>ID del pago: ${outgoingPayment.id}</p>
          <a href="/">Volver a la tienda</a>
        </body>
      </html>
    `);

    // B) O redirige a tu SPA para vaciar carrito:
    // return res.redirect("/?paid=1");
  } catch (err) {
    console.error("/pay/callback error:", err);
    return res.status(500).send(`
      <html>
        <head><meta charset="utf-8"><title>Error</title></head>
        <body style="font-family: sans-serif;">
          <h2>❌ Hubo un problema al procesar el pago</h2>
          <pre>${(err && err.message) || "Error desconocido"}</pre>
          <a href="/">Volver</a>
        </body>
      </html>
    `);
  }
});

// ============ FLUJO EXISTENTE (/quote + /pago) ============

// Crear quote (API)
app.post("/quote", async (req, res) => {
  try {
    const amountMajor = Number(req.body?.amountMXN);
    if (!Number.isFinite(amountMajor) || amountMajor <= 0) {
      return res.status(400).json({ success: false, error: "amountMXN inválido" });
    }

    const sendingClient = await sendingClientPromise;

    const sendingWalletAddress = await sendingClient.walletAddress.get({
      url: SENDING_WALLET_ADDRESS_URL,
    });
    const receivingWalletAddress = await sendingClient.walletAddress.get({
      url: RECEIVING_WALLET_ADDRESS_URL,
    });

    const assetCode = receivingWalletAddress.assetCode;
    const assetScale = Number(receivingWalletAddress.assetScale ?? 2);

    // 1) Grant (receptor) → Incoming Payment
    const incomingPaymentGrant = await sendingClient.grant.request(
      { url: receivingWalletAddress.authServer },
      {
        access_token: {
          access: [{ type: "incoming-payment", actions: ["read", "create", "complete"] }],
        },
      }
    );

    const incomingPayment = await sendingClient.incomingPayment.create(
      {
        url: receivingWalletAddress.resourceServer,
        accessToken: incomingPaymentGrant.access_token.value,
      },
      {
        walletAddress: receivingWalletAddress.id,
        incomingAmount: {
          assetCode,
          assetScale,
          value: toMinor(amountMajor, assetScale),
        },
      }
    );

    // 2) Grant (emisor) → Quote
    const quoteGrant = await sendingClient.grant.request(
      { url: sendingWalletAddress.authServer },
      { access_token: { access: [{ type: "quote", actions: ["create", "read"] }] } }
    );

    const quote = await sendingClient.quote.create(
      {
        url: sendingWalletAddress.resourceServer,
        accessToken: quoteGrant.access_token.value,
      },
      { walletAddress: sendingWalletAddress.id, receiver: incomingPayment.id, method: "ilp" }
    );

    // 3) Grant interactivo (emisor) para Outgoing Payment
    const outgoingPaymentGrant = await sendingClient.grant.request(
      { url: sendingWalletAddress.authServer },
      {
        access_token: {
          access: [
            {
              type: "outgoing-payment",
              actions: ["read", "create"],
              limits: { debitAmount: quote.debitAmount },
              identifier: sendingWalletAddress.id,
            },
          ],
        },
        interact: { start: ["redirect"] },
      }
    );

    pendingGrants.set(incomingPayment.id, {
      continueUri: outgoingPaymentGrant.continue.uri,
      continueAccessToken: outgoingPaymentGrant.continue.access_token.value,
      quoteId: quote.id,
    });

    res.json({
      success: true,
      incomingPaymentId: incomingPayment.id,
      debitAmount: quote.debitAmount,
      interactRedirect: outgoingPaymentGrant.interact.redirect,
    });
  } catch (err) {
    console.error("/quote error:", err);
    const msg =
      err instanceof OpenPaymentsClientError
        ? `${err.name}: ${err.message}`
        : err?.message || "Error desconocido";
    res.status(500).json({ success: false, error: msg });
  }
});

// Ejecutar pago (API)
app.post("/pago", async (req, res) => {
  try {
    const incomingPaymentId = req.body?.incomingPaymentId;
    const stash = pendingGrants.get(incomingPaymentId);
    if (!stash) {
      return res.status(400).json({ success: false, error: "No hay grant pendiente" });
    }

    const sendingClient = await sendingClientPromise;
    const sendingWalletAddress = await sendingClient.walletAddress.get({
      url: SENDING_WALLET_ADDRESS_URL,
    });

    // Continuar grant (no interact_ref en este flujo)
    const finalized = await sendingClient.grant.continue({
      url: stash.continueUri,
      accessToken: stash.continueAccessToken,
    });

    if (!isFinalizedGrant(finalized)) {
      return res
        .status(400)
        .json({ success: false, error: "Grant no finalizado. Acepta la autorización." });
    }

    const outgoingPayment = await sendingClient.outgoingPayment.create(
      {
        url: sendingWalletAddress.resourceServer,
        accessToken: finalized.access_token.value,
      },
      { walletAddress: sendingWalletAddress.id, quoteId: stash.quoteId }
    );

    pendingGrants.delete(incomingPaymentId);

    res.json({ success: true, outgoingPayment });
  } catch (err) {
    console.error("/pago error:", err);
    const msg =
      err instanceof OpenPaymentsClientError
        ? `${err.name}: ${err.message}`
        : err?.message || "Error desconocido";
    res.status(500).json({ success: false, error: msg });
  }
});

// Fallback al index
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Handler global por si algo se escapa
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

app.listen(PORT, () => {
  console.log(`Servidor en ${BASE_URL}`);
});
