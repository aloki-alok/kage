import { ownerChannelLine, whatsappLine } from '../../core/doctor.ts'
import { wahaSeen, wahaUrl } from '../../connectors/whatsapp.ts'
import { settings } from '../home.ts'
import { ROOT, type Group } from './context.ts'

export const whatsapp: Group = async () => {
  const { config, secrets } = settings()
  const key = secrets.waha?.WAHA_API_KEY
  const on = config.connectors?.whatsapp?.on !== false && !!key
  const owner = ownerChannelLine(config.owner?.channel, on)
  if (!on) return owner ? [owner] : []
  const url = wahaUrl(config.connectors?.whatsapp?.wahaUrl)
  return [whatsappLine(await wahaSeen(url, key), { url, qr: `${ROOT}/waha/qr.sh` }), ...owner ? [owner] : []]
}
