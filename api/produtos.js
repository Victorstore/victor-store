import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      erro: 'Método não permitido'
    })
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY
    )

    const { data, error } = await supabase
      .from('produtos')
      .select('*')
      .eq('ativo', true)
      .order('id', { ascending: true })

    if (error) {
      return res.status(500).json({
        ok: false,
        erro: error.message
      })
    }

    return res.status(200).json({
      ok: true,
      produtos: data
    })
  } catch (erro) {
    return res.status(500).json({
      ok: false,
      erro: erro.message
    })
  }
}
