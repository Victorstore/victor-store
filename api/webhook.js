import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const texto = valor =>
  typeof valor === "string" ? valor : "";

function statusDaLoja(order) {
  const status = texto(order.status);
  const detalhe = texto(order.status_detail);

  if (status === "processed" && detalhe === "accredited") {
    return "pago";
  }

  if (
    status === "processed" &&
    detalhe === "partially_refunded"
  ) {
    return "parcialmente_reembolsado";
  }

  if (status === "refunded") return "reembolsado";
  if (status === "charged_back") return "em_contestacao";

  if (
    detalhe === "expired" &&
    ["failed", "canceled"].includes(status)
  ) {
    return "expirado";
  }

  if (status === "canceled") return "cancelado";
  if (status === "failed") return "falhou";

  if (
    status === "action_required" &&
    ["waiting_payment", "waiting_transfer"].includes(detalhe)
  ) {
    return "aguardando_pagamento";
  }

  if (status === "processing") return "em_processamento";

  return "verificar_pagamento";
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "Webhook Victor Store ativo"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido"
    });
  }

  try {
    const secret =
      process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    const token =
      process.env.MERCADO_PAGO_ACCESS_TOKEN;
    const url =
      process.env.SUPABASE_URL;
    const chave =
      process.env.SUPABASE_SECRET_KEY;

    if (!secret || !token || !url || !chave) {
      console.error("Webhook com configuração incompleta.");

      return res.status(503).json({
        error: "Webhook não configurado."
      });
    }

    const assinatura = texto(req.headers["x-signature"]);
    const requestId = texto(req.headers["x-request-id"]);
    const dataId = texto(req.query?.["data.id"]);

    if (!assinatura || !requestId || !dataId) {
      return res.status(401).json({
        error: "Webhook sem autenticação."
      });
    }

    const partes = assinatura
      .split(",")
      .map(parte => parte.trim());

    const ts = partes
      .find(parte => parte.startsWith("ts="))
      ?.slice(3);

    const v1 = partes
      .find(parte => parte.startsWith("v1="))
      ?.slice(3);

    if (
      !ts ||
      !/^\d+$/.test(ts) ||
      !v1 ||
      !/^[a-fA-F0-9]{64}$/.test(v1)
    ) {
      return res.status(401).json({
        error: "Assinatura inválida."
      });
    }

    const manifest =
      `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;

    const esperada = crypto
      .createHmac("sha256", secret)
      .update(manifest)
      .digest();

    if (
      !crypto.timingSafeEqual(
        esperada,
        Buffer.from(v1, "hex")
      )
    ) {
      return res.status(401).json({
        error: "Assinatura inválida."
      });
    }

    // Este endpoint recebe eventos da API de Orders.
    if (req.body?.type && req.body.type !== "order") {
      return res.status(200).json({
        received: true,
        ignored: true
      });
    }

    if (!/^ORD[a-zA-Z0-9]+$/.test(dataId)) {
      return res.status(400).json({
        error: "Identificador de order inválido."
      });
    }

    if (
      req.body?.data?.id &&
      String(req.body.data.id).toLowerCase() !==
        dataId.toLowerCase()
    ) {
      return res.status(400).json({
        error: "Identificadores divergentes."
      });
    }

    // Confirma o status diretamente no Mercado Pago.
    const resposta = await fetch(
      `https://api.mercadopago.com/v1/orders/${encodeURIComponent(dataId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!resposta.ok) {
      console.error(
        "Consulta da order falhou:",
        resposta.status
      );

      return res.status(503).json({
        error: "Não foi possível consultar o pagamento."
      });
    }

    const order = await resposta.json();

    if (
      String(order.id).toLowerCase() !==
      dataId.toLowerCase()
    ) {
      return res.status(400).json({
        error: "Order divergente."
      });
    }

    const referencia = texto(order.external_reference);

    if (!referencia.startsWith("victor-store-")) {
      return res.status(200).json({
        received: true,
        ignored: true
      });
    }

    const supabase = createClient(url, chave, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const { data: pedido, error: erroBusca } =
      await supabase
        .from("pedidos")
        .select(`
          id,
          referencia,
          mercado_pago_order_id,
          total,
          status,
          status_pagamento,
          updated_at
        `)
        .eq("referencia", referencia)
        .maybeSingle();

    if (erroBusca || !pedido) {
      console.error(
        "Pedido da notificação ainda não localizado."
      );

      return res.status(503).json({
        error: "Pedido não localizado."
      });
    }

    if (
      pedido.mercado_pago_order_id &&
      pedido.mercado_pago_order_id !== String(order.id)
    ) {
      return res.status(409).json({
        error: "Pagamento não corresponde ao pedido."
      });
    }

    const total = Number(order.total_amount);

    if (
      !Number.isFinite(total) ||
      Math.round(total * 100) !==
        Math.round(Number(pedido.total) * 100)
    ) {
      return res.status(409).json({
        error: "Valor do pagamento divergente."
      });
    }

    const pagamentos = order.transactions?.payments;

    if (
      !Array.isArray(pagamentos) ||
      pagamentos.length !== 1
    ) {
      return res.status(409).json({
        error: "Transações incompatíveis com este pedido."
      });
    }

    const status = statusDaLoja(order);

    // Evita que uma leitura antiga reabra um pedido pago.
    const posteriores = [
      "pago",
      "parcialmente_reembolsado",
      "reembolsado",
      "em_contestacao"
    ];

    if (
      posteriores.includes(pedido.status) &&
      !posteriores.includes(status)
    ) {
      return res.status(200).json({
        received: true,
        ignored: true
      });
    }

    if (
      ["reembolsado", "em_contestacao"].includes(
        pedido.status
      ) &&
      status !== pedido.status
    ) {
      return res.status(200).json({
        received: true,
        ignored: true
      });
    }

    if (
      pedido.status === "parcialmente_reembolsado" &&
      status === "pago"
    ) {
      return res.status(200).json({
        received: true,
        ignored: true
      });
    }

    const statusPagamento = texto(order.status);

    const pagamentoId = pagamentos[0]?.id
      ? String(pagamentos[0].id)
      : null;

    // Notificações repetidas não precisam alterar o pedido.
    if (
      pedido.status === status &&
      pedido.status_pagamento === statusPagamento &&
      pedido.mercado_pago_order_id === String(order.id)
    ) {
      return res.status(200).json({
        received: true,
        unchanged: true
      });
    }

    const { data: atualizados, error: erroUpdate } =
      await supabase
        .from("pedidos")
        .update({
          mercado_pago_order_id: String(order.id),
          mercado_pago_payment_id: pagamentoId,
          status,
          status_pagamento: statusPagamento
        })
        .eq("id", pedido.id)
        .eq("updated_at", pedido.updated_at)
        .select("id");

    if (erroUpdate || !atualizados?.length) {
      return res.status(503).json({
        error: "Não foi possível atualizar o pedido."
      });
    }

    console.log(
      "Status do pedido atualizado:",
      pedido.id,
      status
    );

    return res.status(200).json({
      received: true
    });
  } catch (erro) {
    console.error("Erro no webhook:", erro.message);

    return res.status(503).json({
      error: "Falha temporária no webhook."
    });
  }
}
