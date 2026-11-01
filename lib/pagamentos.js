// Consulta somente recursos oficiais do Mercado Pago. Nunca aceita status do navegador.
export class FalhaPagamento extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}
export async function consultarMP(caminho, token) {
  const resposta = await fetch(`https://api.mercadopago.com${caminho}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000)
  });
  if (!resposta.ok) throw new FalhaPagamento("Não foi possível consultar o pagamento.");
  return resposta.json();
}
const posteriores = ["pago", "parcialmente_reembolsado", "reembolsado", "em_contestacao"];
export function statusOrder(order) {
  const s = order.status, d = order.status_detail;
  if (s === "processed" && d === "accredited") return "pago";
  if (s === "processed" && d === "partially_refunded") return "parcialmente_reembolsado";
  if (s === "refunded") return "reembolsado";
  if (s === "charged_back") return "em_contestacao";
  if (d === "expired" && ["failed", "canceled"].includes(s)) return "expirado";
  if (s === "canceled") return "cancelado";
  if (s === "failed") return "falhou";
  if (s === "action_required" && ["waiting_payment", "waiting_transfer"].includes(d)) return "aguardando_pagamento";
  if (s === "processing") return "em_processamento";
  return "verificar_pagamento";
}
export function statusPayment(p) {
  if (p.status === "charged_back") return "em_contestacao";
  if (p.status === "refunded") return "reembolsado";
  if (p.status === "approved") return Number(p.transaction_amount_refunded) > 0 ? "parcialmente_reembolsado" : "pago";
  if (p.status === "cancelled") return p.status_detail === "expired" ? "expirado" : "cancelado";
  if (p.status === "rejected") return "falhou";
  if (["in_process", "authorized", "in_mediation"].includes(p.status)) return "em_processamento";
  if (p.status === "pending") return "aguardando_pagamento";
  return "verificar_pagamento";
}
export function conferirValor(valor, total) {
  if (!Number.isFinite(Number(valor)) || !Number.isFinite(Number(total)) ||
      Number(valor) <= 0 || Math.round(Number(valor) * 100) !== Math.round(Number(total) * 100)) {
    throw new FalhaPagamento("Valor do pagamento divergente.", 409);
  }
}
export async function aplicarStatus(db, pedido, atualizacao) {
  const novo = atualizacao.status;
  if ((posteriores.includes(pedido.status) && !posteriores.includes(novo)) ||
      (["reembolsado", "em_contestacao"].includes(pedido.status) && novo !== pedido.status) ||
      (pedido.status === "parcialmente_reembolsado" && novo === "pago")) {
    return { received: true, ignored: true };
  }
  const igual = Object.entries(atualizacao).every(([k, v]) => pedido[k] === v);
  if (!igual) {
    const { data, error } = await db.from("pedidos").update(atualizacao)
      .eq("id", pedido.id).eq("updated_at", pedido.updated_at).select("id");
    if (error || !data?.length) throw new FalhaPagamento("Não foi possível atualizar o pedido.");
  }
  if (novo === "pago") {
    const { data, error } = await db.rpc("baixar_estoque_pedido", { p_pedido_id: pedido.id });
    if (error || data?.ok !== true) {
      console.error("Pagamento registrado; estoque pendente:", pedido.id);
      throw new FalhaPagamento("Pagamento registrado; baixa de estoque pendente.");
    }
    return { received: true, estoque: data.ja_baixado ? "ja_baixado" : "baixado" };
  }
  return { received: true, unchanged: igual };
}
export async function buscarPedido(db, campo, valor) {
  const { data, error } = await db.from("pedidos").select(
    "id,referencia,checkout_tipo,mercado_pago_preference_id,mercado_pago_order_id,mercado_pago_payment_id,total,ambiente,status,status_pagamento,updated_at,estoque_baixado_em"
  ).eq(campo, valor).maybeSingle();
  if (error || !data) throw new FalhaPagamento("Pedido não localizado.");
  return data;
}
export async function sincronizarPro(db, pedido, token, pagamentoId = null) {
  if (pedido.checkout_tipo !== "checkout_pro" || !pedido.mercado_pago_preference_id) {
    throw new FalhaPagamento("Checkout ainda não vinculado ao pedido.");
  }
  if (!pagamentoId) {
    const busca = await consultarMP(`/v1/payments/search?external_reference=${encodeURIComponent(pedido.referencia)}&sort=date_created&criteria=desc&limit=100`, token);
    if (!Array.isArray(busca.results)) throw new FalhaPagamento("Resultado da consulta inválido.");
    const lista = busca.results.filter(p => p.external_reference === pedido.referencia);
    // Um pagamento aprovado tem prioridade sobre tentativas recusadas no mesmo checkout.
    const existente = posteriores.includes(pedido.status) && lista.find(p => String(p.id) === pedido.mercado_pago_payment_id);
    const escolhido = existente || lista.find(p => ["approved", "refunded", "charged_back"].includes(p.status)) || lista[0];
    if (!escolhido) return { received: true, pending: true };
    pagamentoId = String(escolhido.id);
  }
  if (!/^\d+$/.test(String(pagamentoId))) throw new FalhaPagamento("Pagamento inválido.", 400);
  const p = await consultarMP(`/v1/payments/${encodeURIComponent(pagamentoId)}`, token);
  if (String(p.id) !== String(pagamentoId) || p.external_reference !== pedido.referencia || p.currency_id !== "BRL") {
    throw new FalhaPagamento("Pagamento não corresponde ao pedido.", 409);
  }
  // Esta entrega fica restrita aos testes. Produção será habilitada em outra etapa.
  if (pedido.ambiente !== "teste" || p.live_mode !== false) throw new FalhaPagamento("Ambiente de pagamento divergente.", 409);
  conferirValor(p.transaction_amount, pedido.total);
  const merchantId = String(p.order?.id || "");
  if (!/^\d+$/.test(merchantId)) throw new FalhaPagamento("Pedido comercial não informado.");
  const comercial = await consultarMP(`/merchant_orders/${merchantId}`, token);
  if (String(comercial.id) !== merchantId || String(comercial.preference_id) !== pedido.mercado_pago_preference_id ||
      comercial.external_reference !== pedido.referencia ||
      !comercial.payments?.some(x => String(x.id) === String(p.id))) {
    throw new FalhaPagamento("Preferência de pagamento divergente.", 409);
  }
  const status = statusPayment(p);
  if (posteriores.includes(pedido.status) && pedido.mercado_pago_payment_id && pedido.mercado_pago_payment_id !== String(p.id)) {
    if (posteriores.includes(status)) {
      console.error("Outro pagamento aprovado para o mesmo pedido; conferir:", pedido.id, String(p.id));
      throw new FalhaPagamento("Outro pagamento localizado. Conferência necessária.", 409);
    }
    return { received: true, ignored: true };
  }
  return aplicarStatus(db, pedido, { mercado_pago_payment_id: String(p.id), status, status_pagamento: String(p.status) });
}
