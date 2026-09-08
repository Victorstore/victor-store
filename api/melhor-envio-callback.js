export default async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({
      error: "Código de autorização não recebido."
    });
  }

  try {
    const resposta = await fetch(
      "https://sandbox.melhorenvio.com.br/oauth/token",
      {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": process.env.MELHOR_ENVIO_USER_AGENT
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: process.env.MELHOR_ENVIO_CLIENT_ID,
          client_secret: process.env.MELHOR_ENVIO_CLIENT_SECRET,
          redirect_uri:
            "https://victor-store-nine.vercel.app/api/melhor-envio-callback",
          code: code
        })
      }
    );

    const dados = await resposta.json();

    if (!resposta.ok) {
      return res.status(resposta.status).json({
        error: "Erro ao obter token do Melhor Envio.",
        detalhes: dados
      });
    }

    return res.status(200).json({
      message: "Autorização realizada com sucesso.",
      tokenRecebido: !!dados.access_token
    });

  } catch (erro) {
    console.error("Erro Melhor Envio:", erro);

    return res.status(500).json({
      error: "Erro ao comunicar com o Melhor Envio."
    });
  }
}
