export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      message: "Webhook Victor Store ativo"
    });
  }

  try {
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
