// The WAHA bridge (#351): checked only when the hub would start WhatsApp (hub/connectors.ts), so the same keys and kill switch.
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
