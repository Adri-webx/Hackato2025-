import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import {
  createAuthenticatedClient,
  OpenPaymentsClientError,
} from "@interledger/open-payments";

const app = express();
app.use(bodyParser.json());
app.use(cors()); // permite peticiones desde tu HTML

// Verificar que exista la clave privada
if (!fs.existsSync("private.key")) {
  console.error("❌ private.key no encontrado");
  process.exit(1);
}

// Crear cliente Interledger (wallet de envío)
const client = await createAuthenticatedClient({
  walletAddressUrl: "https://ilp.interledger-test.dev/bed6ad54", // wallet de envío (EUR)
  privateKey: "private.key",
  keyId: "343932d8-9c72-48f3-89d9-aa5617831b0",
});

// Wallet de recepción (MXN)
const receiverWalletUrl = "https://ilp.interledger-test.dev/jjhjvh";

// Endpoint para generar quote (EUR → MXN)
app.post("/quote", async (req, res) => {
  const { amountMXN } = req.body;

  try {
    // 1️⃣ Obtener wallet de recepción
    const receivingWallet = await client.walletAddress.get({ url: receiverWalletUrl });

    // 2️⃣ Crear grant para incoming payment
    const incomingGrant = await client.grant.request(
      { url: receivingWallet.authServer },
      {
        access_token: {
          access: [{ type: "incoming-payment", actions: ["read","complete","create"] }]
        }
      }
    );

    // 3️⃣ Crear incoming payment
    const incomingPayment = await client.incomingPayment.create(
      { url: receivingWallet.resourceServer, accessToken: incomingGrant.access_token.value },
      {
        walletAddress: receivingWallet.id,
        incomingAmount: {
          assetCode: receivingWallet.assetCode,
          assetScale: receivingWallet.assetScale,
          value: amountMXN.toString()
        }
      }
    );

    // 4️⃣ Crear grant para quote en wallet de envío
    const sendingWallet = await client.walletAddress.get({ url: client.walletAddressUrl });

    const quoteGrant = await client.grant.request(
      { url: sendingWallet.authServer },
      {
        access_token: {
          access: [{ type: "quote", actions: ["create","read"] }]
        }
      }
    );

    // 5️⃣ Crear quote EUR → MXN
    const quote = await client.quote.create(
      { url: sendingWallet.resourceServer, accessToken: quoteGrant.access_token.value },
      {
        walletAddress: sendingWallet.id,
        receiver: incomingPayment.id,
        method: "ilp"
      }
    );

    res.json({
      success: true,
      incomingPaymentId: incomingPayment.id,
      debitAmount: quote.debitAmount,
      creditAmount: quote.creditAmount,
    });

  } catch (err) {
    console.error("❌ Error en /quote:", err);
    res.json({ success: false, error: err.message });
  }
});

// Endpoint para realizar pago final
app.post("/pago", async (req,res)=>{
  const { incomingPaymentId } = req.body;

  try {
    const sendingWallet = await client.walletAddress.get({ url: client.walletAddressUrl });

    // 1️⃣ Grant para outgoing payment
    const outgoingGrant = await client.grant.request(
      { url: sendingWallet.authServer },
      {
        access_token: {
          access: [{ type: "outgoing-payment", actions: ["create","read"] }]
        }
      }
    );

    // 2️⃣ Crear outgoing payment
    const outgoingPayment = await client.outgoingPayment.create(
      { url: sendingWallet.resourceServer, accessToken: outgoingGrant.access_token.value },
      {
        walletAddress: sendingWallet.id,
        quoteId: incomingPaymentId
      }
    );

    res.json({ success:true, payment: outgoingPayment });

  } catch(err){
    console.error("❌ Error en /pago:", err);
    res.json({ success:false, error: err.message });
  }
});

app.listen(3000, ()=>console.log("Servidor corriendo en http://localhost:3000"));
