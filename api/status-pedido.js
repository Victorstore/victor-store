import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buscarPedido, sincronizarPro } from "../lib/pagamentos.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, erro: "Método não permitido." });
  }
  const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!secret || !url || !key) {
    return res.status(503).json({ ok: false, erro: "Consulta indisponível." });
  }
  const { pedido_id: id, token } = req.body || {};
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || typeof token !== "string") {
    return res.status(401).json({ ok: false, erro: "Consulta inválida." });
  }
  const partes = /^(\d{10})\.([0-9a-f]{64})$/.exec(token);
  if (!partes || Number(partes[1]) <= Math.floor(Date.now() / 1000)) {
    return res.status(401).json({ ok: false, erro: "Consulta inválida ou expirada." });
  }
  const esperado = crypto.createHmac("sha256", secret)
    .update(`${id}:${partes[1]}`).digest();
  if (!crypto.timingSafeEqual(esperado, Buffer.from(partes[2], "hex"))) {
    return res.status(401).json({ ok: false, erro: "Consulta inválida." });
  }
  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase.from("pedidos")
      .select("status,ambiente,checkout_tipo").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, erro: "Pedido não encontrado." });
    if (data.checkout_tipo === "checkout_pro") {
      const tokenMP = process.env.MERCADO_PAGO_ACCESS_TOKEN;
      if (!tokenMP) throw new Error("Credencial indisponível");
      const pedido = await buscarPedido(supabase, "id", id);
      await sincronizarPro(supabase, pedido, tokenMP);
      const atualizado = await buscarPedido(supabase, "id", id);
      return res.status(200).json({ ok: true, status: atualizado.status, ambiente: atualizado.ambiente });
    }
    return res.status(200).json({ ok: true, status: data.status, ambiente: data.ambiente });
  } catch {
    return res.status(503).json({ ok: false, erro: "Não foi possível consultar o pedido." });
  }
}
