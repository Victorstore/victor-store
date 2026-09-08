export default async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({
      error: "Código de autorização não recebido."
    });
  }

  return res.status(200).json({
    message: "Autorização do Melhor Envio recebida com sucesso.",
    codeRecebido: true
  });
}
