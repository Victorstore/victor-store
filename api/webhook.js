import crypto from "crypto";
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      message: "Webhook Victor Store ativo"
    });
  }

  try {
    const assinatura = req.headers["x-signature"];
const requestId = req.headers["x-request-id"];
const webhookSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;

if (!webhookSecret) {
  console.error("MERCADO_PAGO_WEBHOOK_SECRET não configurado.");
  return res.status(500).json({
    error: "Webhook secret não configurado."
  });
}
   const dataId = req.query["data.id"];

if (!assinatura || !requestId || !dataId) {
  console.error("Webhook sem dados de autenticação.");
  return res.status(401).json({
    error: "Webhook inválido."
  });
}
    const partesAssinatura = assinatura.split(",");

const ts = partesAssinatura
  .find(parte => parte.trim().startsWith("ts="))
  ?.split("=")[1];

const v1 = partesAssinatura
  .find(parte => parte.trim().startsWith("v1="))
  ?.split("=")[1];

if (!ts || !v1) {
  console.error("Formato da assinatura inválido.");
  return res.status(401).json({
    error: "Assinatura inválida."
  });
}
    const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;

const assinaturaEsperada = crypto
  .createHmac("sha256", webhookSecret)
  .update(manifest)
  .digest("hex");

const assinaturaValida =
  assinaturaEsperada.length === v1.length &&
  crypto.timingSafeEqual(
    Buffer.from(assinaturaEsperada),
    Buffer.from(v1)
  );

if (!assinaturaValida) {
  console.error("Assinatura do webhook não confere.");
  return res.status(401).json({
    error: "Assinatura inválida."
  });
}
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;

if (!accessToken) {
  console.error("MERCADO_PAGO_ACCESS_TOKEN não configurado.");
  return res.status(500).json({
    error: "Access Token não configurado."
  });
}
const respostaOrder = await fetch(
  `https://api.mercadopago.com/v1/orders/${dataId}`,
  {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }
);

const order = await respostaOrder.json();

if (!respostaOrder.ok) {
  console.error("Erro ao consultar order:", order);

  return res.status(200).json({
    received: true
  });
}

console.log("Order:", order.id);
console.log("Status:", order.status);
console.log("Order completa:", JSON.stringify(order));
console.log("Referência:", order.external_reference);
console.log("Valor:", order.total_amount);
    console.log("=== WEBHOOK MERCADO PAGO ===");
    console.log("Headers:", req.headers);
    console.log("Body:", JSON.stringify(req.body));

    return res.status(200).json({
      received: true
    });
  } catch (erro) {
    console.error("Erro no webhook:", erro);

    return res.status(200).json({
      received: true
    });
  }
}
