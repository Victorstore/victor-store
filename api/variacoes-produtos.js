import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      erro: 'Método não permitido'
    })
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY
    )

    const produtoId = req.query.produto_id

    if (!produtoId) {
      return res.status(400).json({
        ok: false,
        erro: 'produto_id é obrigatório'
      })
    }

    const { data, error } = await supabase
      .from('variacoes_produtos')
      .select('*')
      .eq('produto_id', produtoId)
      .eq('ativo', true)
      .gt('estoque', 0)
      .order('faixa', { ascending: true })
      .order('cor', { ascending: true })
      .order('numero', { ascending: true })

    if (error) {
      return res.status(500).json({
        ok: false,
        erro: error.message
      })
    }

    return res.status(200).json({
      ok: true,
      variacoes: data
    })
  } catch (erro) {
    return res.status(500).json({
      ok: false,
      erro: erro.message
    })
  }
}
