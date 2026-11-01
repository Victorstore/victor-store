import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { consultarMP } from "../lib/pagamentos.js";

const escapar = (valor) =>
  String(valor ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

const moeda = (valor) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(Number(valor) || 0);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido"
    });
  }

  let supabase;
  let pedidoLocalId;
  let envioIniciado = false;
  let respostaRecebida = false;

  try {
    const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;

    if (!process.env.MERCADO_PAGO_WEBHOOK_SECRET) {
      return res.status(503).json({ error: "Consulta de pagamento não configurada." });
    }

    if (!accessToken) {
      return res.status(500).json({
        error: "Credencial do Mercado Pago não configurada."
      });
    }

    // Os detalhes da loja não são enviados ao Mercado Pago.
    const {
      detalhes_loja: detalhes = {},
      checkout_tipo: checkoutTipo = "pix_orders",
      ...pedido
    } = req.body || {};

    if (!["pix_orders", "checkout_pro"].includes(checkoutTipo)) {
      return res.status(400).json({ error: "Forma de pagamento inválida." });
    }
    const pro = checkoutTipo === "checkout_pro";
    // Bloqueia o Checkout Pro se a credencial pertencer a um vendedor real.
    if (pro) {
      const vendedor = await consultarMP("/users/me", accessToken);
      if (!Array.isArray(vendedor.tags) || !vendedor.tags.includes("test_user")) {
        return res.status(503).json({ error: "Checkout Pro: configure o Access Token da conta vendedora de teste. Nenhum pagamento foi iniciado." });
      }
    }
    const url = process.env.SUPABASE_URL;
    const chave = process.env.SUPABASE_SECRET_KEY;

    if (!url || !chave) {
      return res.status(500).json({
        error: "Conexão com o Supabase não configurada."
      });
    }

    supabase = createClient(url, chave, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    let referencia = String(pedido.external_reference || "");

    const tipoEntrega = [
      "calcular",
      "topic",
      "retirada",
      "combinar"
    ].find((tipo) =>
      referencia.startsWith("victor-store-" + tipo + "-")
    );

    const itensEntrada = detalhes?.itens;
    const freteEntrada = detalhes?.frete || {};

    const valorTotal = Number(pedido.total_amount);

    const valorFrete =
      tipoEntrega === "calcular"
        ? Number(freteEntrada.preco)
        : 0;

    const pagamentos = pedido.transactions?.payments;

    const nomeCliente = String(
      pedido.payer?.first_name || ""
    ).trim();

    const emailCliente = String(
      pedido.payer?.email || ""
    ).trim();

    const telefoneCliente = [
      pedido.payer?.phone?.area_code,
      pedido.payer?.phone?.number
    ].filter(Boolean).join(" ");

    if (
      !tipoEntrega ||
      !nomeCliente ||
      !emailCliente ||
      !Array.isArray(itensEntrada) ||
      itensEntrada.length === 0 ||
      itensEntrada.length > 100 ||
      !Number.isFinite(valorTotal) ||
      valorTotal <= 0 ||
      !Number.isFinite(valorFrete) ||
      valorFrete < 0 ||
      !Array.isArray(pagamentos) ||
      pagamentos.length !== 1 ||
      Number(pagamentos[0].amount) !== valorTotal ||
      pagamentos[0].payment_method?.id !== "pix"
    ) {
      return res.status(400).json({
        error: "Os dados do pedido estão incompletos ou inválidos."
      });
    }

    if (
      tipoEntrega === "calcular" &&
      !/^\d{8}$/.test(String(freteEntrada.cep || ""))
    ) {
      return res.status(400).json({
        error: "Informe um CEP válido para a entrega."
      });
    }

    if (pro) {
      referencia = `victor-store-${tipoEntrega}-pro-${crypto.randomUUID()}`;
      pedido.external_reference = referencia;
    }
    const itensParaSalvar = itensEntrada.map((item) => ({
      produto_id: item.produto_id,
      variacao_id: item.variacao_id ?? null,
      quantidade: item.quantidade
    }));

    // O ambiente permanece de teste nesta etapa.
    const {
      data: idRegistrado,
      error: erroRegistro
    } = await supabase.rpc("registrar_pedido_loja", {
      p_pedido: {
        referencia,
        ambiente: "teste",
        cliente_nome: nomeCliente,
        cliente_email: emailCliente,
        cliente_telefone: telefoneCliente,
        frete_valor: valorFrete,
        total: valorTotal,
        entrega_tipo: tipoEntrega,
        entrega_cep:
          tipoEntrega === "calcular"
            ? String(freteEntrada.cep)
            : null,
        entrega_transportadora:
          tipoEntrega === "calcular"
            ? freteEntrada.transportadora
            : null,
        entrega_servico:
          tipoEntrega === "calcular"
            ? freteEntrada.nome
            : null,
        entrega_prazo:
          tipoEntrega === "calcular"
            ? String(freteEntrada.prazo ?? "A confirmar")
            : null
      },
      p_itens: itensParaSalvar
    });

    if (erroRegistro || !idRegistrado) {
      console.error(
        "Pedido não registrado:",
        erroRegistro?.code
      );

      return res.status(400).json({
        error:
          "Não foi possível registrar o pedido. Confira preços, estoque e itens do carrinho antes de tentar novamente."
      });
    }

    pedidoLocalId = idRegistrado;

    // Usa os nomes e preços efetivamente salvos no banco.
    const {
      data: itensSalvos,
      error: erroItens
    } = await supabase
      .from("pedido_itens")
      .select(
        "produto_nome, variacao_descricao, quantidade, preco_unitario"
      )
      .eq("pedido_id", pedidoLocalId);

    if (erroItens || !itensSalvos?.length) {
      await supabase
        .from("pedidos")
        .update({
          status: "erro_preparacao",
          status_pagamento: "nao_iniciado"
        })
        .eq("id", pedidoLocalId);

      return res.status(500).json({
        error:
          "O pedido foi registrado, mas não foi possível preparar o pagamento."
      });
    }

    detalhes.itens = itensSalvos.map((item) => ({
      nome: item.produto_nome,
      variacao: item.variacao_descricao,
      quantidade: item.quantidade,
      preco: Number(item.preco_unitario)
    }));

    // O tipo deve estar salvo antes de disponibilizar a URL ao comprador.
    if (pro) {
      const { error } = await supabase.from("pedidos").update({ checkout_tipo: "checkout_pro" })
        .eq("id", pedidoLocalId).eq("status", "pendente");
      if (error) throw new Error("Não foi possível preparar o Checkout Pro.");
    }
    let corpoMP = pedido;
    if (pro) {
      const origem = "https://victor-store-nine.vercel.app";
      const retorno = `${origem}/retorno-pagamento.html?pedido=${encodeURIComponent(pedidoLocalId)}`;
      const itensMP = itensSalvos.map((item, i) => ({
        id: `${pedidoLocalId}-${i}`, title: item.produto_nome,
        description: item.variacao_descricao || item.produto_nome,
        quantity: Number(item.quantidade), unit_price: Number(item.preco_unitario), currency_id: "BRL"
      }));
      if (valorFrete > 0) itensMP.push({ id: "frete", title: "Frete da compra", quantity: 1, unit_price: valorFrete, currency_id: "BRL" });
      corpoMP = {
        items: itensMP,
        payer: { name: nomeCliente, email: emailCliente },
        external_reference: referencia,
        back_urls: { success: retorno, failure: retorno, pending: retorno },
        auto_return: "approved",
        notification_url: `${origem}/api/webhook?source_news=webhooks`,
        expires: true,
        expiration_date_from: new Date(Date.now() - 60000).toISOString(),
        expiration_date_to: new Date(Date.now() + 86400000).toISOString()
      };
    }
    envioIniciado = true;
    const resposta = await fetch(pro ? "https://api.mercadopago.com/checkout/preferences" : "https://api.mercadopago.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "X-Idempotency-Key": pedidoLocalId },
      body: JSON.stringify(corpoMP), signal: AbortSignal.timeout(15000)
    });
    const dados = await resposta.json();
    respostaRecebida = true;
    const pagamento = dados.transactions?.payments?.[0];
    let checkoutUrl = null;
    if (pro && resposta.ok) {
      const destino = new URL(dados.init_point);
      if (destino.protocol !== "https:" || destino.hostname !== "www.mercadopago.com.br" || !dados.id) {
        throw new Error("URL de checkout inválida.");
      }
      checkoutUrl = destino.href;
    }
    const atualizacao = resposta.ok
      ? (pro ? {
          mercado_pago_preference_id: String(dados.id),
          status: "aguardando_pagamento", status_pagamento: "aguardando_pagamento"
        } : {
          mercado_pago_order_id: dados.id ? String(dados.id) : null,
          mercado_pago_payment_id: pagamento?.id ? String(pagamento.id) : null,
          status: "aguardando_pagamento",
          status_pagamento: String(pagamento?.status || dados.status || "aguardando_pagamento")
        })
      : { status: "erro_pagamento", status_pagamento: "criacao_recusada" };

    const { error: erroVinculo } = await supabase
      .from("pedidos")
      .update(atualizacao)
      .eq("id", pedidoLocalId)
      .eq("status", "pendente");

    if (erroVinculo && pro) {
      return res.status(503).json({ error: "Checkout criado, mas não foi possível vinculá-lo ao pedido. Entre em contato com a loja.", pedido_local_id: pedidoLocalId });
    }
    if (erroVinculo) {
      console.error(
        "Falha ao vincular pagamento ao pedido:",
        pedidoLocalId
      );
    }

    if (resposta.ok) {
      try {
        const resendApiKey = process.env.RESEND_API_KEY;
        const pedidosEmail = process.env.PEDIDOS_EMAIL;

        if (!resendApiKey || !pedidosEmail) {
          console.error(
            "RESEND_API_KEY ou PEDIDOS_EMAIL não configurado."
          );
        } else {
          const formas = {
            topic: "Entrega regional por Topic",
            retirada: "Retirada em Crateús",
            combinar: "Frete a combinar com o vendedor",
            calcular: "Frete calculado pelo CEP"
          };

          const formaEntrega =
            formas[tipoEntrega] || "Não identificada";

          const itens = detalhes.itens;

          const linhas = itens.map((item) => `
            <tr>
              <td style="padding:10px;border-bottom:1px solid #ddd">
                <strong>${escapar(item.nome)}</strong>
                <br>
                <small>${escapar(item.variacao || "")}</small>
              </td>
              <td style="padding:10px">
                ${escapar(item.quantidade)}
              </td>
              <td style="padding:10px">
                ${moeda(item.preco)}
              </td>
              <td style="padding:10px">
                ${moeda(
                  Number(item.preco) * Number(item.quantidade)
                )}
              </td>
            </tr>
          `).join("");

          const observacoes = {
            topic:
              "Combinar com o cliente o valor da Topic e se o transporte será pago no envio ou no recebimento.",
            retirada:
              "Combinar com o cliente o local e o horário da retirada em Crateús.",
            combinar:
              "Entrar em contato com o cliente para definir valor, prazo e forma de entrega."
          };

          const subtotalProdutos = itens.reduce(
            (soma, item) =>
              soma +
              Number(item.preco) * Number(item.quantidade),
            0
          );

          const html = `
            <div style="
              font-family:Arial,sans-serif;
              max-width:750px;
              margin:auto;
              color:#222;
            ">
              <h2 style="color:#e50914">
                Novo pedido - Victor Store
              </h2>

              <p>Um novo pedido foi criado na loja.</p>

              <h3>Dados do pedido</h3>

              <p>
                <strong>Registro na loja:</strong>
                ${escapar(pedidoLocalId)}
              </p>

              <p>
                <strong>Pedido:</strong>
                ${escapar(dados.id || "Não informado")}
              </p>

              <p>
                <strong>Valor:</strong>
                ${moeda(dados.total_amount || pedido.total_amount)}
              </p>

              <p>
                <strong>Forma de entrega:</strong>
                ${escapar(formaEntrega)}
              </p>

              <p>
                <strong>Status:</strong>
                ${pro ? "Aguardando pagamento no Mercado Pago" : "Aguardando pagamento via Pix"}
              </p>

              <hr>

              <h3>Produtos</h3>

              <table style="
                width:100%;
                border-collapse:collapse;
                text-align:left;
              ">
                <thead>
                  <tr>
                    <th>Produto / variação</th>
                    <th>Qtd.</th>
                    <th>Unitário</th>
                    <th>Subtotal</th>
                  </tr>
                </thead>
                <tbody>${linhas}</tbody>
              </table>

              <p>
                <strong>Subtotal dos produtos:</strong>
                ${moeda(subtotalProdutos)}
              </p>

              <h3>Entrega</h3>

              ${
                tipoEntrega === "calcular"
                  ? `
                    <p>
                      <strong>Transportadora:</strong>
                      ${escapar(
                        freteEntrada.transportadora ||
                        "Não informada"
                      )}
                    </p>

                    <p>
                      <strong>Serviço:</strong>
                      ${escapar(
                        freteEntrada.nome || "Não informado"
                      )}
                    </p>

                    <p>
                      <strong>CEP:</strong>
                      ${escapar(
                        freteEntrada.cep || "Não informado"
                      )}
                    </p>

                    <p>
                      <strong>Prazo informado na cotação:</strong>
                      ${escapar(
                        freteEntrada.prazo ?? "A confirmar"
                      )}
                    </p>

                    <p>
                      <strong>Frete:</strong>
                      ${moeda(valorFrete)}
                    </p>
                  `
                  : ""
              }

              ${
                observacoes[tipoEntrega]
                  ? `<p>${escapar(
                      observacoes[tipoEntrega]
                    )}</p>`
                  : ""
              }

              <hr>

              <h3>Cliente</h3>

              <p>
                <strong>Nome:</strong>
                ${escapar(nomeCliente)}
              </p>

              <p>
                <strong>E-mail:</strong>
                ${escapar(emailCliente)}
              </p>

              <p>
                <strong>Telefone:</strong>
                ${escapar(
                  telefoneCliente || "Não informado"
                )}
              </p>

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
                Authorization: `Bearer ${resendApiKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                from:
                  "Victor Store <onboarding@resend.dev>",
                to: [pedidosEmail],
                subject:
                  `Novo pedido Victor Store - ${formaEntrega}`,
                html
              })
            }
          );

          if (!respostaEmail.ok) {
            console.error(
              "Erro ao enviar e-mail:",
              respostaEmail.status
            );
          }
        }
      } catch (erroEmail) {
        console.error(
          "Erro na notificação por e-mail:",
          erroEmail.message
        );
      }
    }

    return res.status(resposta.status).json({
      ...(pro ? (resposta.ok ? { checkout_tipo: "checkout_pro", checkout_url: checkoutUrl } : { error: "Não foi possível abrir o Checkout Pro. Confira as credenciais de teste e a aplicação no Mercado Pago." }) : dados),
      pedido_local_id: pedidoLocalId,
      consulta_token: resposta.ok ? (() => {
        const expira = Math.floor(Date.now() / 1000) + 86400;
        const assinatura = crypto.createHmac("sha256", process.env.MERCADO_PAGO_WEBHOOK_SECRET)
          .update(`${pedidoLocalId}:${expira}`).digest("hex");
        return `${expira}.${assinatura}`;
      })() : null
    });
  } catch (erro) {
    console.error(
      "Erro no processamento do pedido:",
      erro.message
    );

    if (
      supabase &&
      pedidoLocalId &&
      !respostaRecebida
    ) {
      try {
        await supabase
          .from("pedidos")
          .update({
            status: envioIniciado
              ? "verificar_pagamento"
              : "erro_preparacao",
            status_pagamento: envioIniciado
              ? "resultado_desconhecido"
              : "nao_iniciado"
          })
          .eq("id", pedidoLocalId)
          .eq("status", "pendente");
      } catch {
        console.error(
          "Não foi possível atualizar o pedido:",
          pedidoLocalId
        );
      }
    }

    return res.status(500).json({
      error: envioIniciado
        ? "Não foi possível confirmar o resultado do pagamento. Consulte o pedido na loja antes de tentar novamente."
        : "Não foi possível preparar o pedido.",
      pedido_local_id: pedidoLocalId || null
    });
  }
}