import { whatsappLine } from '../../core/doctor.ts'
import { wahaSeen, wahaUrl } from '../../connectors/whatsapp.ts'
import { settings } from '../home.ts'
import { ROOT, type Group } from './context.ts'

export const whatsapp: Group = async () => {
  const { config, secrets } = settings()
  const key = secrets.waha?.WAHA_API_KEY
  if (config.connectors?.whatsapp?.on === false || !key) return []
  const url = wahaUrl(config.connectors?.whatsapp?.wahaUrl)
  return [whatsappLine(await wahaSeen(url, key), { url, qr: `${ROOT}/waha/qr.sh` })]
}
