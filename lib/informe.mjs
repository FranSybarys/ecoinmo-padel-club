// Genera el informe mensual en HTML a partir de los datos en Postgres.
// Lo usan tanto el cron (api/informe-mensual.js) como el envio manual.
import { getSql } from './db.mjs';

const TZ = 'Europe/Madrid';
const MES = ['','enero','febrero','marzo','abril','mayo','junio','julio',
             'agosto','septiembre','octubre','noviembre','diciembre'];

const eur = (n) => (Number(n)||0).toLocaleString('es-ES',
  {minimumFractionDigits:0, maximumFractionDigits:0}) + ' €';
const num = (n) => (Number(n)||0).toLocaleString('es-ES');
const pc  = (a,b) => b>0 ? (100*a/b).toFixed(1)+'%' : '—';

// Clasifica cada cancelacion segun lo que paso con el hueco.
// El CASE del LEFT JOIN es imprescindible: LEAST/GREATEST ignoran los
// NULL y sin el una cancelada sin sustituta sale cubierta al 100%.
const CANC = `
  WITH cob AS (
    SELECT c.booking_id, c.duration_min, c.price_amount, c.payment_status,
           c.booking_type, c.origin,
           EXTRACT(hour FROM c.start_at AT TIME ZONE '${TZ}')::int AS hora,
           COALESCE(SUM(CASE WHEN v.booking_id IS NULL THEN 0 ELSE
             EXTRACT(epoch FROM (LEAST(v.end_at,c.end_at)
               - GREATEST(v.start_at,c.start_at)))/60.0 END),0) AS min_cub,
           COALESCE(BOOL_OR(v.start_at=c.start_at AND v.end_at=c.end_at),false) AS gemela
    FROM bookings c
    LEFT JOIN bookings v ON v.resource_id=c.resource_id AND NOT v.is_canceled
      AND v.start_at < c.end_at AND v.end_at > c.start_at
    WHERE c.is_canceled AND c.start_at >= $1 AND c.start_at < $2
    GROUP BY 1,2,3,4,5,6,7),
  clas AS (
    SELECT *, CASE
      WHEN gemela THEN 'sustituida'
      WHEN min_cub >= COALESCE(duration_min,0)*0.9 AND min_cub>0 THEN 'recuperada'
      WHEN min_cub > 0 THEN 'parcial' ELSE 'vacia' END AS estado,
      GREATEST(COALESCE(duration_min,0)-min_cub,0) AS min_perdidos
    FROM cob)
`;

export async function datosMes(from, to) {
  const sql = getSql();
  const [kpi, origen, objetivo, ocup, canc, cancHora, cancTipo, pistas, tipos, prev] =
    await Promise.all([
      sql.query(`SELECT COALESCE(SUM(price_amount),0)::float8 facturacion,
          COUNT(*)::int reservas, COUNT(DISTINCT owner_id)::int jugadores,
          COALESCE(SUM(duration_min),0)::float8/60 horas
        FROM bookings WHERE NOT is_canceled AND start_at>=$1 AND start_at<$2
          AND payment_status IN ('PAID','PARTIAL_PAID','PENDING','UNPAID')`, [from,to]),
      sql.query(`SELECT CASE WHEN origin IN ('MANAGER','PLAYTOMIC_MANAGER')
            THEN 'directa' ELSE 'marketplace' END canal,
          COALESCE(SUM(price_amount),0)::float8 euros, COUNT(*)::int reservas
        FROM bookings WHERE NOT is_canceled AND start_at>=$1 AND start_at<$2
          AND payment_status IN ('PAID','PARTIAL_PAID','PENDING','UNPAID') GROUP BY 1`, [from,to]),
      sql.query(`SELECT COALESCE(SUM(target),0)::float8 objetivo FROM targets
        WHERE month>=$1 AND month<$2`, [from,to]),
      sql.query(`WITH f AS (
          SELECT gs franja, EXTRACT(epoch FROM (LEAST(b.end_at, gs+INTERVAL '1 hour')
            - GREATEST(b.start_at,gs)))/60.0 min
          FROM bookings b CROSS JOIN LATERAL generate_series(date_trunc('hour',b.start_at),
            b.end_at - INTERVAL '1 microsecond', INTERVAL '1 hour') gs
          WHERE NOT b.is_canceled AND b.start_at>=$1 AND b.start_at<$2),
        d AS (SELECT COUNT(DISTINCT (start_at AT TIME ZONE '${TZ}')::date) n
          FROM bookings WHERE NOT is_canceled AND start_at>=$1 AND start_at<$2)
        SELECT EXTRACT(hour FROM franja AT TIME ZONE '${TZ}')::int hora,
          ROUND((100.0*SUM(min)/60.0/NULLIF((SELECT COUNT(*) FROM courts WHERE active)
            *(SELECT n FROM d),0))::numeric,1)::float8 pct
        FROM f GROUP BY 1 ORDER BY 1`, [from,to]),
      sql.query(CANC+`SELECT estado, COUNT(*)::int n,
          ROUND((SUM(min_perdidos)/60.0)::numeric)::float8 horas,
          COALESCE(ROUND(SUM(price_amount) FILTER (WHERE payment_status='REFUNDED')),0)::float8 eur
        FROM clas GROUP BY 1`, [from,to]),
      sql.query(CANC+`SELECT hora, COUNT(*)::int canc,
          COUNT(*) FILTER (WHERE estado='vacia')::int vacias
        FROM clas GROUP BY 1 HAVING COUNT(*)>=3 ORDER BY 1`, [from,to]),
      sql.query(CANC+`SELECT booking_type tipo, COUNT(*)::int canc,
          COUNT(*) FILTER (WHERE estado='vacia')::int vacias,
          ROUND((SUM(min_perdidos)/60.0)::numeric)::float8 horas
        FROM clas GROUP BY 1 ORDER BY canc DESC`, [from,to]),
      sql.query(`SELECT co.resource_name pista,
          COUNT(*) FILTER (WHERE NOT b.is_canceled)::int reservas,
          COALESCE(SUM(b.price_amount) FILTER (WHERE NOT b.is_canceled),0)::float8 euros
        FROM bookings b JOIN courts co ON co.resource_id=b.resource_id
        WHERE b.start_at>=$1 AND b.start_at<$2 GROUP BY 1 ORDER BY euros DESC`, [from,to]),
      sql.query(`SELECT booking_type tipo, COUNT(*)::int reservas,
          COALESCE(SUM(price_amount),0)::float8 euros
        FROM bookings WHERE NOT is_canceled AND start_at>=$1 AND start_at<$2
        GROUP BY 1 ORDER BY euros DESC`, [from,to]),
      // Mes anterior, para poder comparar
      sql.query(`SELECT COALESCE(SUM(price_amount),0)::float8 facturacion,
          COUNT(*)::int reservas
        FROM bookings WHERE NOT is_canceled
          AND start_at >= ($1::date - INTERVAL '1 month') AND start_at < $1
          AND payment_status IN ('PAID','PARTIAL_PAID','PENDING','UNPAID')`, [from]),
    ]);

  return { kpi:kpi[0], origen, objetivo:objetivo[0]?.objetivo??0, ocup,
           canc, cancHora, cancTipo, pistas, tipos, prev:prev[0] };
}

const TIPO_NOM = {REGULAR_BOOKING:'Reserva normal', RECURRING_BOOKING:'Reserva recurrente',
  COURSE_CLASS:'Clase de curso', PRIVATE_CLASS:'Clase particular',
  OPEN_MATCH:'Partida abierta', LEAGUE_MATCH:'Partido de liga', TOURNAMENT:'Torneo'};

const ESTADO_NOM = {
  sustituida:['Sustituida','#888888','otra reserva ocupó el mismo hueco'],
  recuperada:['Recuperada','#199e70','el hueco se revendió'],
  parcial:['Parcial','#c98500','se ocupó solo una parte'],
  vacia:['Vacía','#d95926','la pista se quedó sin nadie'],
};

export function generarHTML(d, from) {
  const f = new Date(from + 'T00:00:00Z');
  const titulo = `${MES[f.getUTCMonth()+1]} de ${f.getUTCFullYear()}`;
  const k = d.kpi;
  const pctObj = d.objetivo > 0 ? (k.facturacion / d.objetivo * 100) : null;
  const dir = d.origen.find(x=>x.canal==='directa')?.euros || 0;
  const mkt = d.origen.find(x=>x.canal==='marketplace')?.euros || 0;
  const tot = dir + mkt;

  const cMap = Object.fromEntries(d.canc.map(x=>[x.estado,x]));
  const totalCanc = d.canc.reduce((a,x)=>a+x.n,0);
  const horasPerd = d.canc.reduce((a,x)=>a+(x.horas||0),0);
  const eurPerd = (cMap.vacia?.eur||0) + (cMap.parcial?.eur||0);
  const vacias = cMap.vacia?.n || 0;

  const dif = d.prev.facturacion > 0
    ? ((k.facturacion - d.prev.facturacion) / d.prev.facturacion * 100) : null;

  const th = 'style="text-align:left;padding:8px;border:1px solid #ddd;background:#f5f5f5;font-size:12px;"';
  const thn = 'style="text-align:right;padding:8px;border:1px solid #ddd;background:#f5f5f5;font-size:12px;"';
  const td = 'style="padding:8px;border:1px solid #ddd;"';
  const tdn = 'style="padding:8px;border:1px solid #ddd;text-align:right;font-variant-numeric:tabular-nums;"';
  const h2 = 'style="font-size:17px;border-bottom:1px solid #ddd;padding-bottom:6px;margin-top:30px;"';

  const picoOcup = d.ocup.reduce((a,x)=>(x.pct||0)>(a.pct||0)?x:a,{pct:0,hora:0});
  const valle = d.ocup.filter(x=>(x.pct||0) < 10).map(x=>x.hora);

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;color:#1a1a1a;line-height:1.6;">

<div style="border-bottom:3px solid #e6007e;padding-bottom:16px;margin-bottom:26px;">
  <div style="font-size:12px;color:#888;letter-spacing:1px;text-transform:uppercase;">Campus Pádel Club · PTS Granada</div>
  <h1 style="margin:6px 0 4px 0;font-size:24px;text-transform:capitalize;">Informe de ${titulo}</h1>
  <div style="font-size:13px;color:#666;">ECOINMO Investments · datos de Playtomic</div>
</div>

<div style="background:#f8f8f8;border-left:4px solid #e6007e;padding:18px 22px;margin-bottom:28px;">
  <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.5px;">Facturación del mes</div>
  <div style="font-size:38px;font-weight:700;line-height:1.1;margin:6px 0;">${eur(k.facturacion)}</div>
  <div style="font-size:14px;color:#555;">
    ${pctObj!=null ? `<strong>${pctObj.toFixed(1)}%</strong> del objetivo (${eur(d.objetivo)})` : 'sin objetivo fijado'}
    ${dif!=null ? ` &nbsp;·&nbsp; <span style="color:${dif>=0?'#2e7d32':'#c62828'}">${dif>=0?'▲':'▼'} ${Math.abs(dif).toFixed(1)}% vs mes anterior</span>` : ''}
  </div>
</div>

<h2 ${h2}>Actividad</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<tr><th ${th}>Indicador</th><th ${thn}>Valor</th></tr>
<tr><td ${td}>Reservas</td><td ${tdn}>${num(k.reservas)}</td></tr>
<tr><td ${td}>Jugadores distintos</td><td ${tdn}>${num(k.jugadores)}</td></tr>
<tr><td ${td}>Horas de pista jugadas</td><td ${tdn}>${num(Math.round(k.horas))}</td></tr>
<tr><td ${td}>Ingreso medio por reserva</td><td ${tdn}>${k.reservas?eur(k.facturacion/k.reservas):'—'}</td></tr>
<tr><td ${td}>Ocupación máxima</td><td ${tdn}>${(picoOcup.pct||0).toFixed(0)}% a las ${String(picoOcup.hora).padStart(2,'0')}:00</td></tr>
</table>

<h2 ${h2}>Origen de la facturación</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<tr><th ${th}>Canal</th><th ${thn}>Facturación</th><th ${thn}>Reservas</th><th ${thn}>%</th></tr>
<tr><td ${td}>Directa (mostrador / Manager)</td><td ${tdn}>${eur(dir)}</td>
  <td ${tdn}>${d.origen.find(x=>x.canal==='directa')?.reservas||0}</td><td ${tdn}>${pc(dir,tot)}</td></tr>
<tr><td ${td}>Marketplace de Playtomic</td><td ${tdn}>${eur(mkt)}</td>
  <td ${tdn}>${d.origen.find(x=>x.canal==='marketplace')?.reservas||0}</td><td ${tdn}>${pc(mkt,tot)}</td></tr>
</table>

<h2 ${h2}>Ventas por tipo de reserva</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<tr><th ${th}>Tipo</th><th ${thn}>Reservas</th><th ${thn}>Facturación</th></tr>
${d.tipos.map(t=>`<tr><td ${td}>${TIPO_NOM[t.tipo]||t.tipo}</td>
  <td ${tdn}>${num(t.reservas)}</td><td ${tdn}>${eur(t.euros)}</td></tr>`).join('')}
</table>

<h2 ${h2}>Ocupación por franja horaria</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px;">
${d.ocup.map(o=>{
  const p = o.pct||0;
  const col = p>=50?'#199e70':p>=25?'#c98500':'#d95926';
  return `<tr>
    <td style="padding:4px 8px;width:46px;color:#666;font-variant-numeric:tabular-nums;">${String(o.hora).padStart(2,'0')}h</td>
    <td style="padding:4px 0;"><div style="background:#eee;border-radius:3px;height:14px;">
      <div style="width:${Math.min(p,100)}%;background:${col};height:14px;border-radius:3px;"></div></div></td>
    <td style="padding:4px 8px;width:46px;text-align:right;color:#666;font-variant-numeric:tabular-nums;">${p.toFixed(0)}%</td></tr>`;
}).join('')}
</table>
${valle.length ? `<p style="font-size:13px;color:#666;margin-top:10px;">
  Franjas por debajo del 10%: ${valle.map(h=>String(h).padStart(2,'0')+'h').join(', ')}.</p>` : ''}

<h2 ${h2}>Facturación por pista</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<tr><th ${th}>Pista</th><th ${thn}>Reservas</th><th ${thn}>Facturación</th></tr>
${d.pistas.map(p=>`<tr><td ${td}>${p.pista||'—'}</td>
  <td ${tdn}>${num(p.reservas)}</td><td ${tdn}>${eur(p.euros)}</td></tr>`).join('')}
</table>

<h2 ${h2}>Cancelaciones</h2>
<p style="font-size:14px;">
  ${num(totalCanc)} cancelaciones en el mes. Lo relevante no es cuántas, sino
  <strong>si la pista se volvió a llenar</strong>.</p>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<tr><th ${th}>Qué pasó con la hora</th><th ${thn}>Reservas</th><th ${thn}>%</th>
  <th ${thn}>Horas perdidas</th><th ${thn}>Devuelto</th></tr>
${['sustituida','recuperada','parcial','vacia'].map(e=>{
  const x = cMap[e]; if(!x) return '';
  const [nom,col,desc] = ESTADO_NOM[e];
  return `<tr${e==='vacia'?' style="background:#ffebee;"':''}>
    <td ${td}><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${col};margin-right:8px;"></span>
      <strong>${nom}</strong> <span style="color:#888;font-size:12px;">· ${desc}</span></td>
    <td ${tdn}>${x.n}</td><td ${tdn}>${pc(x.n,totalCanc)}</td>
    <td ${tdn}>${Math.round(x.horas||0)}</td><td ${tdn}>${eur(x.eur)}</td></tr>`;
}).join('')}
</table>

<div style="background:${vacias?'#fff8e1':'#e8f5e9'};border-left:4px solid ${vacias?'#ffc107':'#2e7d32'};padding:14px 18px;margin:18px 0;font-size:14px;">
  <strong>Pérdida real del mes:</strong> ${Math.round(horasPerd)} horas-pista sin vender
  y ${eur(eurPerd)} devueltos. El resto de cancelaciones no tuvo coste porque el hueco se volvió a ocupar.
</div>

${d.cancHora.length ? `
<h3 style="font-size:15px;margin-top:24px;">Dónde se pierden las horas</h3>
<table style="width:100%;border-collapse:collapse;font-size:13.5px;">
<tr><th ${th}>Franja</th><th ${thn}>Canceladas</th><th ${thn}>Quedan vacías</th><th ${thn}>%</th></tr>
${d.cancHora.map(h=>`<tr><td ${td}>${String(h.hora).padStart(2,'0')}:00</td>
  <td ${tdn}>${h.canc}</td><td ${tdn}>${h.vacias}</td>
  <td ${tdn}>${pc(h.vacias,h.canc)}</td></tr>`).join('')}
</table>` : ''}

${d.cancTipo.length ? `
<h3 style="font-size:15px;margin-top:24px;">Cancelaciones por tipo</h3>
<table style="width:100%;border-collapse:collapse;font-size:13.5px;">
<tr><th ${th}>Tipo</th><th ${thn}>Canceladas</th><th ${thn}>Quedan vacías</th><th ${thn}>Horas perdidas</th></tr>
${d.cancTipo.map(t=>`<tr><td ${td}>${TIPO_NOM[t.tipo]||t.tipo}</td>
  <td ${tdn}>${t.canc}</td><td ${tdn}>${t.vacias} (${pc(t.vacias,t.canc)})</td>
  <td ${tdn}>${Math.round(t.horas||0)}</td></tr>`).join('')}
</table>` : ''}

<div style="background:#f5f5f5;padding:14px 18px;margin-top:30px;font-size:12.5px;color:#555;">
<strong>Nota metodológica.</strong> Datos de la API oficial de Playtomic.
Una cancelación se considera <em>sustituida</em> si existe otra reserva activa en la misma pista
con idéntico inicio y fin; <em>recuperada</em> si otra reserva activa cubre al menos el 90% del
intervalo; <em>vacía</em> si ninguna la solapa. Los importes de pérdida corresponden solo a
reservas reembolsadas cuyo hueco quedó vacío; las anuladas sin cargo se excluyen.
La ocupación es horas-pista vendidas sobre pistas activas × días con actividad.
<br><br>
<strong>Limitación:</strong> la API no expone quién canceló ni cuándo. El canal de origen indica
dónde se creó la reserva, no quién la anuló.
</div>

<div style="margin-top:24px;padding-top:14px;border-top:1px solid #ddd;font-size:12px;color:#888;">
Informe automático del dashboard de Campus Pádel Club · ECOINMO Investments<br>
<a href="https://www.ecoinmo.club" style="color:#e6007e;">www.ecoinmo.club</a>
</div>

</div>`;
}
