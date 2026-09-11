export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido"
    });
  }

  try {
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;

    if (!accessToken) {
      return res.status(500).json({
        error: "Credencial do Mercado Pago não configurada."
      });
    }

    const resposta = await fetch(
      "https://api.mercadopago.com/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "X-Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify(req.body)
      }
    );

    const dados = await resposta.json();
    console.log("Resposta Mercado Pago:", JSON.stringify(dados));
    return res.status(resposta.status).json(dados);

  } catch (erro) {
    console.error("Erro Mercado Pago:", erro);

    return res.status(500).json({
      error: "Erro ao comunicar com o Mercado Pago."
    });
  }
}
