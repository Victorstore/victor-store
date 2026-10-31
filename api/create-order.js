import { randomUUID } from "node:crypto";

const escapar = (valor) => String(valor ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const moeda = valor => new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL"
}).format(Number(valor) || 0);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }
  try {
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: "Credencial do Mercado Pago não configurada." });
    }
    // Os detalhes da loja são usados na notificação, sem enviar campos
    // próprios à API de pagamentos.
    const { detalhes_loja: detalhes = {}, ...pedido } = req.body || {};
    const resposta = await fetch("https://api.mercadopago.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "X-Idempotency-Key": randomUUID()
      },
      body: JSON.stringify(pedido)
    });
    const dados = await resposta.json();

    if (resposta.ok) {
      try {
        const resendApiKey = process.env.RESEND_API_KEY;
        const pedidosEmail = process.env.PEDIDOS_EMAIL;
        if (!resendApiKey || !pedidosEmail) {
          console.error("RESEND_API_KEY ou PEDIDOS_EMAIL não configurado.");
        } else {
          const referencia = String(pedido.external_reference || dados.external_reference || "");
          const formas = {
            topic: "Entrega regional por Topic",
            retirada: "Retirada em Crateús",
            combinar: "Frete a combinar com o vendedor",
            calcular: "Frete calculado pelo CEP"
          };
          const tipo = Object.keys(formas).find(t => referencia.includes(`victor-store-${t}-`));
          const formaEntrega = formas[tipo] || "Não identificada";
          const nome = pedido.payer?.first_name || pedido.payer?.name || pedido.customer?.name || "Não informado";
          const email = pedido.payer?.email || pedido.customer?.email || "Não informado";
          const telefone = pedido.payer?.phone
            ? [pedido.payer.phone.area_code, pedido.payer.phone.number].filter(Boolean).join(" ")
            : pedido.customer?.phone || pedido.customer?.telephone || "Não informado";
          const itens = Array.isArray(detalhes.itens) ? detalhes.itens : [];
          const linhas = itens.map(item => `
            <tr>
              <td style="padding:10px;border-bottom:1px solid #ddd">
                <strong>${escapar(item.nome)}</strong>
                <br><small>${escapar(item.variacao || "")}</small>
              </td>
              <td style="padding:10px">${escapar(item.quantidade)}</td>
              <td style="padding:10px">${moeda(item.preco)}</td>
              <td style="padding:10px">${moeda(Number(item.preco) * Number(item.quantidade))}</td>
            </tr>`).join("");
          const observacoes = {
            topic: "Combinar com o cliente o valor da Topic e se o transporte será pago no envio ou no recebimento.",
            retirada: "Combinar com o cliente o local e o horário da retirada em Crateús.",
            combinar: "Entrar em contato com o cliente para definir valor, prazo e forma de entrega."
          };
          const frete = detalhes.frete || {};
          const html = `
            <div style="font-family:Arial,sans-serif;max-width:750px;margin:auto;color:#222">
              <h2 style="color:#e50914">Novo pedido - Victor Store</h2>
              <p>Um novo pedido foi criado na loja.</p>
              <h3>Dados do pedido</h3>
              <p><strong>Pedido:</strong> ${escapar(dados.id || "Não informado")}</p>
              <p><strong>Valor:</strong> ${moeda(dados.total_amount || pedido.total_amount)}</p>
              <p><strong>Forma de entrega:</strong> ${escapar(formaEntrega)}</p>
              <p><strong>Status:</strong> Aguardando pagamento via Pix</p>
              <hr><h3>Produtos</h3>
              ${itens.length ? `<table style="width:100%;border-collapse:collapse;text-align:left">
                <thead><tr><th>Produto / variação</th><th>Qtd.</th><th>Unitário</th><th>Subtotal</th></tr></thead>
                <tbody>${linhas}</tbody></table>
                <p><strong>Subtotal dos produtos:</strong> ${moeda(itens.reduce((s,i) => s + Number(i.preco)*Number(i.quantidade), 0))}</p>`
                : "<p>Detalhes dos produtos não recebidos nesta versão do pedido.</p>"}
              <h3>Entrega</h3>
              ${tipo === "calcular" ? `
                <p><strong>Transportadora:</strong> ${escapar(frete.transportadora || "Não informada")}</p>
                <p><strong>Serviço:</strong> ${escapar(frete.nome || "Não informado")}</p>
                <p><strong>CEP:</strong> ${escapar(frete.cep || "Não informado")}</p>
                <p><strong>Prazo informado na cotação:</strong> ${escapar(frete.prazo ?? "A confirmar")}</p>
                <p><strong>Frete:</strong> ${moeda(frete.preco)}</p>` : ""}
              ${observacoes[tipo] ? `<p>${escapar(observacoes[tipo])}</p>` : ""}
              <hr><h3>Cliente</h3>
              <p><strong>Nome:</strong> ${escapar(nome)}</p>
              <p><strong>E-mail:</strong> ${escapar(email)}</p>
              <p><strong>Telefone:</strong> ${escapar(telefone)}</p>
              <p style="margin-top:30px;font-size:12px;color:#777">Notificação automática da Victor Store.</p>
            </div>`;
          const respostaEmail = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Victor Store <onboarding@resend.dev>",
              to: [pedidosEmail],
              subject: `Novo pedido Victor Store - ${formaEntrega}`,
              html
            })
          });
          if (!respostaEmail.ok) console.error("Erro ao enviar e-mail:", respostaEmail.status);
        }
      } catch (erroEmail) {
        console.error("Erro na notificação por e-mail:", erroEmail.message);
      }
    }
    return res.status(resposta.status).json(dados);
  } catch (erro) {
    console.error("Erro Mercado Pago:", erro.message);
    return res.status(500).json({ error: "Erro ao comunicar com o Mercado Pago." });
  }
}
