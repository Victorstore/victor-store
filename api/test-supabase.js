import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY
    )

    const { data, error } = await supabase
      .from('produtos')
      .select('*')
      .limit(1)

    if (error) {
      return res.status(500).json({
        ok: false,
        erro: error.message
      })
    }

    return res.status(200).json({
      ok: true,
      mensagem: 'Conexão com o Supabase funcionando',
      resultado: data
    })
  } catch (erro) {
    return res.status(500).json({
      ok: false,
      erro: erro.message
    })
  }
}
