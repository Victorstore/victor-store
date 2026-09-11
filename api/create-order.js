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

    console.log(
      "Resposta Mercado Pago:",
      JSON.stringify(dados)
    );

    // Só tenta enviar a notificação se a Order foi criada.
    if (resposta.ok) {
      try {
        const resendApiKey = process.env.RESEND_API_KEY;
        const pedidosEmail = process.env.PEDIDOS_EMAIL;

        if (!resendApiKey || !pedidosEmail) {
          console.error(
            "RESEND_API_KEY ou PEDIDOS_EMAIL não configurado."
          );
        } else {
          const referencia = String(
            req.body?.external_reference ||
            dados?.external_reference ||
            ""
          );

          let formaEntrega = "Não identificada";

          if (referencia.includes("victor-store-topic-")) {
            formaEntrega = "Entrega regional por Topic";
          } else if (
            referencia.includes("victor-store-retirada-")
          ) {
            formaEntrega = "Retirada em Crateús";
          } else if (
            referencia.includes("victor-store-combinar-")
          ) {
            formaEntrega = "Frete a combinar com o vendedor";
          } else if (
            referencia.includes("victor-store-calcular-")
          ) {
            formaEntrega = "Frete calculado pelo CEP";
          }

          const nomeCliente =
            req.body?.payer?.first_name ||
            req.body?.payer?.name ||
            req.body?.customer?.name ||
            "Não informado";

          const emailCliente =
            req.body?.payer?.email ||
            req.body?.customer?.email ||
            "Não informado";

          const telefoneCliente =
            req.body?.payer?.phone?.number ||
            req.body?.customer?.phone ||
            req.body?.customer?.telephone ||
            "Não informado";

          const valor =
            dados?.total_amount ||
            req.body?.total_amount ||
            "0.00";

          const orderId =
            dados?.id ||
            "Não informado";

          const assunto =
            `Novo pedido Victor Store - ${formaEntrega}`;

          const html = `
            <div style="
              font-family:Arial,sans-serif;
              max-width:650px;
              margin:auto;
              color:#222;
            ">
              <h2 style="color:#e50914;">
                Novo pedido - Victor Store
              </h2>

              <p>
                Um novo pedido foi criado na loja.
              </p>

              <hr>

              <h3>Dados do pedido</h3>

              <p>
                <strong>Pedido:</strong>
                ${orderId}
              </p>

              <p>
                <strong>Valor:</strong>
                R$ ${String(valor).replace(".", ",")}
              </p>

              <p>
                <strong>Forma de entrega:</strong>
                ${formaEntrega}
              </p>

              <p>
                <strong>Status:</strong>
                Aguardando pagamento via Pix
              </p>

              <hr>

              <h3>Cliente</h3>

              <p>
                <strong>Nome:</strong>
                ${nomeCliente}
              </p>

              <p>
                <strong>E-mail:</strong>
                ${emailCliente}
              </p>

              <p>
                <strong>Telefone:</strong>
                ${telefoneCliente}
              </p>

              <hr>

              ${
                formaEntrega === "Entrega regional por Topic"
                  ? `
                    <p>
                      <strong>Observação:</strong>
                      combinar com o cliente o valor da Topic
                      e se o transporte será pago no envio
                      ou no recebimento.
                    </p>
                  `
                  : ""
              }

              ${
                formaEntrega === "Retirada em Crateús"
                  ? `
                    <p>
                      <strong>Observação:</strong>
                      combinar com o cliente o local e o
                      horário da retirada em Crateús.
                    </p>
                  `
                  : ""
              }

              ${
                formaEntrega ===
                "Frete a combinar com o vendedor"
                  ? `
                    <p>
                      <strong>Observação:</strong>
                      entrar em contato com o cliente para
                      definir valor, prazo e forma de entrega.
                    </p>
                  `
                  : ""
              }

              <p style="
                margin-top:30px;
                font-size:12px;
                color:#777;
              ">
                Notificação automática da Victor Store.
              </p>
            </div>
          `;

          const respostaEmail = await fetch(
            "https://api.resend.com/emails",
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${resendApiKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                from: "Victor Store <onboarding@resend.dev>",
                to: [pedidosEmail],
                subject: assunto,
                html
              })
            }
          );

          const dadosEmail =
            await respostaEmail.json();

          if (!respostaEmail.ok) {
            console.error(
              "Erro ao enviar e-mail:",
              dadosEmail
            );
          } else {
            console.log(
              "E-mail de novo pedido enviado:",
              dadosEmail.id
            );
          }
        }

      } catch (erroEmail) {
        console.error(
          "Erro na notificação por e-mail:",
          erroEmail
        );
      }
    }

    return res
      .status(resposta.status)
      .json(dados);

  } catch (erro) {
    console.error(
      "Erro Mercado Pago:",
      erro
    );

    return res.status(500).json({
      error: "Erro ao comunicar com o Mercado Pago."
    });
  }
}
