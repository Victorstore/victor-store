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

    return res.status(200).json({
      message: "CEP recebido com sucesso.",
      cep: cepLimpo,
      freteDisponivel: false
    });

  } catch (erro) {
    console.error("Erro ao calcular frete:", erro);

    return res.status(500).json({
      error: "Erro ao calcular frete."
    });
  }
}
