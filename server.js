// server.js
import express from "express";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { readFileSync } from "fs";
import { exec } from "child_process";
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

// Sirve tu frontend desde la raíz del proyecto (index.html, estilos.css, img/, etc.)
app.use(express.static(__dirname));

// Ruta específica para servir index.html en la raíz
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const {
  PORT = 5500,
  BASE_URL = `http://localhost:5500`,

  // Emisor (quien paga)
  SENDING_WALLET_ADDRESS_URL,
  SENDING_KEY_ID,
  SENDING_PRIVATE_KEY_PATH, // p.ej. ./key/sender_private.key

  // Receptor (quien cobra)
  RECEIVING_WALLET_ADDRESS_URL,
  RECEIVING_KEY_ID,
  RECEIVING_PRIVATE_KEY_PATH, // p.ej. ./key/receiver_private.key
} = process.env;

// ---- Cliente autenticado (Receptor) ----
async function makeReceiverClient() {
  try {
    // Validar que las variables de entorno estén configuradas
    if (!RECEIVING_WALLET_ADDRESS_URL) {
      throw new Error('RECEIVING_WALLET_ADDRESS_URL no está configurada');
    }
    if (!RECEIVING_KEY_ID) {
      throw new Error('RECEIVING_KEY_ID no está configurada');
    }
    if (!RECEIVING_PRIVATE_KEY_PATH) {
      throw new Error('RECEIVING_PRIVATE_KEY_PATH no está configurada');
    }

    console.log('Configuración del cliente receptor:');
    console.log('- Wallet URL:', RECEIVING_WALLET_ADDRESS_URL);
    console.log('- Key ID:', RECEIVING_KEY_ID);
    console.log('- Private Key Path:', RECEIVING_PRIVATE_KEY_PATH);

    const privateKey = readFileSync(RECEIVING_PRIVATE_KEY_PATH, "utf8");
    console.log('- Private Key del receptor cargada correctamente');

    const client = await createAuthenticatedClient({
      walletAddressUrl: RECEIVING_WALLET_ADDRESS_URL,
      privateKey: privateKey,
      keyId: RECEIVING_KEY_ID,
    });

    console.log('✅ Cliente receptor autenticado creado exitosamente');
    return client;
  } catch (error) {
    console.error('❌ Error creando el cliente receptor:', error.message);
    throw error;
  }
}

// ---- Cliente autenticado (Emisor) ----
async function makeSenderClient() {
  try {
    // Validar que las variables de entorno estén configuradas
    if (!SENDING_WALLET_ADDRESS_URL) {
      throw new Error('SENDING_WALLET_ADDRESS_URL no está configurada');
    }
    if (!SENDING_KEY_ID) {
      throw new Error('SENDING_KEY_ID no está configurada');
    }
    if (!SENDING_PRIVATE_KEY_PATH) {
      throw new Error('SENDING_PRIVATE_KEY_PATH no está configurada');
    }

    console.log('Configuración del cliente:');
    console.log('- Wallet URL:', SENDING_WALLET_ADDRESS_URL);
    console.log('- Key ID:', SENDING_KEY_ID);
    console.log('- Private Key Path:', SENDING_PRIVATE_KEY_PATH);

    const privateKey = readFileSync(SENDING_PRIVATE_KEY_PATH, "utf8");
    console.log('- Private Key cargada correctamente');

    const client = await createAuthenticatedClient({
      walletAddressUrl: SENDING_WALLET_ADDRESS_URL,
      privateKey: privateKey,
      keyId: SENDING_KEY_ID,
    });

    console.log('✅ Cliente autenticado creado exitosamente');
    return client;
  } catch (error) {
    console.error('❌ Error creando el cliente autenticado:', error.message);
    throw error;
  }
}

// Inicializar ambos clientes con manejo de errores
let sendingClientPromise;
let receivingClientPromise;
try {
  sendingClientPromise = makeSenderClient();
  receivingClientPromise = makeReceiverClient();
} catch (error) {
  console.error('❌ Error inicial del cliente:', error);
  process.exit(1);
}

// Función para probar la conectividad de las wallet addresses
async function testWalletConnectivity() {
  try {
    console.log('\n🔍 Probando conectividad de wallets...');
    
    // Probar cliente emisor
    const sendingClient = await sendingClientPromise;
    const sendingWallet = await sendingClient.walletAddress.get({
      url: SENDING_WALLET_ADDRESS_URL
    });
    console.log('✅ Wallet emisora conectada:', sendingWallet.id);
    
    // Probar cliente receptor
    const receivingClient = await receivingClientPromise;
    const receivingWallet = await receivingClient.walletAddress.get({
      url: RECEIVING_WALLET_ADDRESS_URL
    });
    console.log('✅ Wallet receptora conectada:', receivingWallet.id);
    
    console.log('✅ Todas las wallets están funcionando correctamente\n');
    return true;
  } catch (error) {
    console.error('❌ Error de conectividad de wallets:', error.message);
    console.error('   Verifica que las URLs de wallet sean correctas y estén activas');
    return false;
  }
}

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
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">
          <title>Error - CBT Tienda</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
            .error-container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .error-title { color: #d32f2f; margin-bottom: 20px; }
            .error-message { color: #666; margin-bottom: 20px; }
            .back-button { background: #1976d2; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; }
            .back-button:hover { background: #1565c0; }
          </style>
        </head>
        <body>
          <div class="error-container">
            <h2 class="error-title">❌ Parámetro inválido</h2>
            <p class="error-message">El monto especificado no es válido. Por favor, regresa y selecciona productos válidos.</p>
            <a href="/" class="back-button">← Volver a la tienda</a>
          </div>
        </body>
        </html>
      `);
    }

    const sendingClient = await sendingClientPromise;
    const receivingClient = await receivingClientPromise;

    // Descubrir wallets
    const sendingWalletAddress = await sendingClient.walletAddress.get({
      url: SENDING_WALLET_ADDRESS_URL,
    });
    const receivingWalletAddress = await receivingClient.walletAddress.get({
      url: RECEIVING_WALLET_ADDRESS_URL,
    });

    const assetCode = receivingWalletAddress.assetCode;
    const assetScale = Number(receivingWalletAddress.assetScale ?? 2);

    console.log('🔍 Debugging grant request:');
    console.log('- Auth Server:', receivingWalletAddress.authServer);
    console.log('- Asset Code:', assetCode);
    console.log('- Asset Scale:', assetScale);

    // 1) Grant (receptor) para crear Incoming Payment - USAR EL CLIENTE RECEPTOR
    let ipGrant;
    try {
      ipGrant = await receivingClient.grant.request(
        { url: receivingWalletAddress.authServer },
        {
          access_token: {
            access: [{ type: "incoming-payment", actions: ["read", "create", "complete"] }],
          },
        }
      );
      console.log('✅ Grant request exitoso');
    } catch (grantError) {
      console.error('❌ Error específico en grant request:', {
        message: grantError.message,
        status: grantError.status,
        code: grantError.code,
        description: grantError.description,
        details: grantError.details
      });
      throw grantError;
    }

    // 2) Crear Incoming Payment (valor en unidades menores) - USAR EL CLIENTE RECEPTOR
    console.log('🔍 Creando Incoming Payment...');
    const incomingPayment = await receivingClient.incomingPayment.create(
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
    console.log('✅ Incoming Payment creado:', incomingPayment.id);

    // 3) Grant (emisor) para crear Quote
    console.log('🔍 Solicitando grant para quote...');
    const quoteGrant = await sendingClient.grant.request(
      { url: sendingWalletAddress.authServer },
      { access_token: { access: [{ type: "quote", actions: ["create", "read"] }] } }
    );
    console.log('✅ Quote grant obtenido');

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
    return res.status(500).send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <title>Error - CBT Tienda</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
          .error-container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .error-title { color: #d32f2f; margin-bottom: 20px; }
          .error-message { color: #666; margin-bottom: 20px; }
          .back-button { background: #1976d2; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; }
          .back-button:hover { background: #1565c0; }
        </style>
      </head>
      <body>
        <div class="error-container">
          <h2 class="error-title">❌ Error en el pago</h2>
          <p class="error-message">No se pudo iniciar el pago. Por favor, intenta de nuevo.</p>
          <a href="/" class="back-button">← Volver a la tienda</a>
        </div>
      </body>
      </html>
    `);
  }
});

// Callback desde la wallet tras autorizar
app.get("/pay/callback", async (req, res) => {
  try {
    const { state, interact_ref } = req.query;
    if (!state || !paySessions.has(state)) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="UTF-8">
          <title>Error - CBT Tienda</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
            .error-container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .error-title { color: #d32f2f; margin-bottom: 20px; }
            .error-message { color: #666; margin-bottom: 20px; }
            .back-button { background: #1976d2; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; }
            .back-button:hover { background: #1565c0; }
          </style>
        </head>
        <body>
          <div class="error-container">
            <h2 class="error-title">❌ Sesión expirada</h2>
            <p class="error-message">La sesión de pago no se encontró o ha expirado. Por favor, intenta realizar el pago nuevamente.</p>
            <a href="/" class="back-button">← Volver a la tienda</a>
          </div>
        </body>
        </html>
      `);
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
        .send(`
          <!DOCTYPE html>
          <html lang="es">
          <head>
            <meta charset="UTF-8">
            <title>Error - CBT Tienda</title>
            <style>
              body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
              .error-container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              .error-title { color: #d32f2f; margin-bottom: 20px; }
              .error-message { color: #666; margin-bottom: 20px; }
              .back-button { background: #1976d2; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; }
              .back-button:hover { background: #1565c0; }
            </style>
          </head>
          <body>
            <div class="error-container">
              <h2 class="error-title">❌ Autorización no completada</h2>
              <p class="error-message">No se pudo finalizar la autorización. ¿Aceptaste el permiso en la wallet?</p>
              <a href="/" class="back-button">← Volver a la tienda</a>
            </div>
          </body>
          </html>
        `);
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

// Handler global por si algo se escapa
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

// Función para abrir el navegador automáticamente
function abrirNavegador(url) {
  const comando = process.platform === 'win32' ? 'start' : 
                  process.platform === 'darwin' ? 'open' : 'xdg-open';
  
  exec(`${comando} ${url}`, (error) => {
    if (error) {
      console.log('No se pudo abrir el navegador automáticamente. Abre manualmente:', url);
    } else {
      console.log(`Navegador abierto en: ${url}`);
    }
  });
}

app.listen(PORT, async () => {
  console.log(`Servidor en ${BASE_URL}`);
  
  // Probar conectividad de wallets
  const walletsOk = await testWalletConnectivity();
  
  if (walletsOk) {
    // Abrir el navegador automáticamente después de 1 segundo
    setTimeout(() => {
      abrirNavegador(BASE_URL);
    }, 1000);
  } else {
    console.log('⚠️  El servidor está funcionando pero hay problemas con las wallets');
    console.log('   Revisa la configuración en el archivo .env');
  }
});
