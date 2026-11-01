import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { FalhaPagamento, consultarMP, buscarPedido, conferirValor, statusOrder, aplicarStatus, sincronizarPro } from "../lib/pagamentos.js";
const texto = v => typeof v === "string" ? v : "";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ ok: true, message: "Webhook Victor Store ativo" });
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });
  try {
    const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
    const url = process.env.SUPABASE_URL, chave = process.env.SUPABASE_SECRET_KEY;
    if (!secret || !token || !url || !chave) throw new FalhaPagamento("Webhook não configurado.");
    const assinatura = texto(req.headers["x-signature"]), requestId = texto(req.headers["x-request-id"]);
    const id = texto(req.query?.["data.id"]);
    if (!assinatura || !requestId || !id) throw new FalhaPagamento("Webhook sem autenticação.", 401);
    const partes = assinatura.split(",").map(p => p.trim());
    const ts = partes.find(p => p.startsWith("ts="))?.slice(3), v1 = partes.find(p => p.startsWith("v1="))?.slice(3);
    if (!ts || !/^\d+$/.test(ts) || !/^[a-fA-F0-9]{64}$/.test(v1 || "")) throw new FalhaPagamento("Assinatura inválida.", 401);
    const esperado = crypto.createHmac("sha256", secret).update(`id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`).digest();
    if (!crypto.timingSafeEqual(esperado, Buffer.from(v1, "hex"))) throw new FalhaPagamento("Assinatura inválida.", 401);
    if (req.body?.data?.id && String(req.body.data.id).toLowerCase() !== id.toLowerCase()) throw new FalhaPagamento("Identificadores divergentes.", 400);
    const tipo = texto(req.body?.type) || texto(req.query?.type) || (/^ORD[a-zA-Z0-9]+$/.test(id) ? "order" : "");
    if (!["order", "payment"].includes(tipo)) return res.status(200).json({ received: true, ignored: true });
    const db = createClient(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });
    if (tipo === "payment") {
      if (!/^\d+$/.test(id)) throw new FalhaPagamento("Pagamento inválido.", 400);
      const p = await consultarMP(`/v1/payments/${id}`, token);
      if (String(p.id) !== id) throw new FalhaPagamento("Pagamento divergente.", 400);
      if (!texto(p.external_reference).startsWith("victor-store-")) return res.status(200).json({ received: true, ignored: true });
      const pedido = await buscarPedido(db, "referencia", p.external_reference);
      if (pedido.checkout_tipo !== "checkout_pro") return res.status(200).json({ received: true, ignored: true });
      return res.status(200).json(await sincronizarPro(db, pedido, token, id));
    }
    if (!/^ORD[a-zA-Z0-9]+$/.test(id)) throw new FalhaPagamento("Identificador de order inválido.", 400);
    const order = await consultarMP(`/v1/orders/${encodeURIComponent(id)}`, token);
    if (String(order.id).toLowerCase() !== id.toLowerCase()) throw new FalhaPagamento("Order divergente.", 400);
    if (!texto(order.external_reference).startsWith("victor-store-")) return res.status(200).json({ received: true, ignored: true });
    const pedido = await buscarPedido(db, "referencia", order.external_reference);
    if (pedido.checkout_tipo !== "pix_orders") throw new FalhaPagamento("Tipo de checkout divergente.", 409);
    if (pedido.mercado_pago_order_id && pedido.mercado_pago_order_id !== String(order.id)) throw new FalhaPagamento("Pagamento não corresponde ao pedido.", 409);
    conferirValor(order.total_amount, pedido.total);
    const pagamentos = order.transactions?.payments;
    if (!Array.isArray(pagamentos) || pagamentos.length !== 1) throw new FalhaPagamento("Transações incompatíveis com este pedido.", 409);
    return res.status(200).json(await aplicarStatus(db, pedido, {
      mercado_pago_order_id: String(order.id), mercado_pago_payment_id: pagamentos[0]?.id ? String(pagamentos[0].id) : null,
      status: statusOrder(order), status_pagamento: texto(order.status)
    }));
  } catch (erro) {
    console.error("Webhook:", erro.message);
    return res.status(erro instanceof FalhaPagamento ? erro.status : 503).json({ error: erro instanceof FalhaPagamento ? erro.message : "Falha temporária no webhook." });
  }
}
