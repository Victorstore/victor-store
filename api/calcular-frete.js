export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido"
    });
  }

  try {
    const { cep } = req.body;

    const cepLimpo = String(cep || "").replace(/\D/g, "");

    if (cepLimpo.length !== 8) {
      return res.status(400).json({
        error: "CEP inválido."
      });
    }

    const cepOrigem = String(
      process.env.MELHOR_ENVIO_CEP_ORIGEM || ""
    ).replace(/\D/g, "");

    if (cepOrigem.length !== 8) {
      return res.status(500).json({
        error: "CEP de origem não configurado."
      });
    }

    const token = process.env.MELHOR_ENVIO_ACCESS_TOKEN;
    const userAgent = process.env.MELHOR_ENVIO_USER_AGENT;

    if (!token) {
      return res.status(500).json({
        error: "Token do Melhor Envio não configurado."
      });
    }

    if (!userAgent) {
      return res.status(500).json({
        error: "User-Agent do Melhor Envio não configurado."
      });
    }

    const resposta = await fetch(
      "https://sandbox.melhorenvio.com.br/api/v2/me/shipment/calculate",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": userAgent
        },
        body: JSON.stringify({
          from: {
            postal_code: cepOrigem
          },
          to: {
            postal_code: cepLimpo
          },

          // Produto de teste.
          // Depois vamos substituir pelos produtos reais do carrinho.
          products: [
            {
              id: "produto-teste",
              width: 20,
              height: 10,
              length: 30,
              weight: 1,
              insurance_value: 50.00,
              quantity: 1
            }
          ],

          options: {
            receipt: false,
            own_hand: false
          }
        })
      }
    );

    const dados = await resposta.json();

    if (!resposta.ok) {
      console.error("Erro Melhor Envio:", dados);

      return res.status(resposta.status).json({
        error: "Erro ao consultar o Melhor Envio.",
        detalhes: dados
      });
    }
console.log("RESPOSTA MELHOR ENVIO:", JSON.stringify(dados));
    const opcoes = dados
      .filter(item => !item.error && item.price)
      .map(item => ({
        id: item.id,
        nome: item.name,
        transportadora: item.company?.name || "",
        preco: item.custom_price || item.price,
        prazo: item.custom_delivery_time || item.delivery_time
      }));

    return res.status(200).json({
      cep: cepLimpo,
      freteDisponivel: opcoes.length > 0,
      opcoes
    });

  } catch (erro) {
    console.error("Erro ao calcular frete:", erro);

    return res.status(500).json({
      error: "Erro interno ao calcular frete."
    });
  }
}
