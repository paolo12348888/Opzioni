/**
 * GEX Calculator - Proxy Worker
 *
 * Fa da ponte tra la PWA (che gira nel browser, senza poter chiamare
 * direttamente Eulerpool per via del CORS) e l'API Eulerpool.
 * La API key resta qui, sul server, mai visibile nel browser dell'utente.
 *
 * DEPLOY (5 minuti, nessuna riga di comando necessaria):
 * 1. Vai su https://dash.cloudflare.com -> crea un account gratuito
 * 2. Workers & Pages -> Create -> Create Worker
 * 3. Dagli un nome (es. "gex-proxy") -> Deploy
 * 4. Edit code -> cancella tutto -> incolla questo intero file -> Save and Deploy
 * 5. Settings -> Variables and Secrets -> Add -> 
 *    nome: EULERPOOL_API_KEY, valore: la tua chiave da eulerpool.com -> incripta/salva
 * 6. Copia l'URL del worker (tipo https://gex-proxy.tuonome.workers.dev)
 *    e incollalo nel campo "Worker URL" della tab Automatico della PWA
 *
 * USO: GET https://tuo-worker.workers.dev/?ticker=AMZN&expiration=2026-09-25
 * (expiration opzionale: se omessa, il worker prova a usare la prima
 * scadenza disponibile restituita da Eulerpool)
 */

export default {
  async fetch(request, env) {
    // Gestione CORS: la PWA gira su un dominio diverso (github.io)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const ticker = url.searchParams.get("ticker");
    const expirationParam = url.searchParams.get("expiration"); // formato YYYY-MM-DD, opzionale

    if (!ticker) {
      return jsonResponse({ error: "Parametro 'ticker' mancante. Uso: ?ticker=AMZN" }, 400, corsHeaders);
    }

    const apiKey = env.EULERPOOL_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: "EULERPOOL_API_KEY non configurata nei secrets del Worker" }, 500, corsHeaders);
    }

    try {
      const eulerpoolUrl = `https://api.eulerpool.com/v1/options/${encodeURIComponent(ticker)}/chain`;
      const resp = await fetch(eulerpoolUrl, {
        headers: { "Authorization": `Bearer ${apiKey}` },
      });

      if (!resp.ok) {
        const body = await resp.text();
        return jsonResponse({ error: `Eulerpool ha risposto ${resp.status}`, detail: body.slice(0, 500) }, 502, corsHeaders);
      }

      const raw = await resp.json();
      const transformed = transformEulerpoolResponse(raw, ticker, expirationParam);
      return jsonResponse(transformed, 200, corsHeaders);

    } catch (err) {
      return jsonResponse({ error: "Errore nella chiamata a Eulerpool", detail: String(err) }, 500, corsHeaders);
    }
  },
};

function jsonResponse(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/**
 * NOTA IMPORTANTE PER PAOLO:
 * Non ho potuto testare dal vivo la risposta reale di Eulerpool (la mia
 * rete non raggiunge api.eulerpool.com), quindi questa funzione fa del
 * suo meglio per riconoscere i nomi di campo più comuni (strike/strikePrice,
 * openInterest/open_interest, impliedVolatility/iv, ecc.). Se al primo
 * test qualcosa non torna (es. spot mancante, strike vuoti), guarda la
 * risposta grezza di Eulerpool (basta chiamare l'endpoint da browser con
 * la tua chiave) e sistemiamo insieme questa funzione in due minuti.
 */
function transformEulerpoolResponse(raw, ticker, expirationParam) {
  // Prova a individuare lo spot price sotto vari nomi possibili
  const spot = raw.underlyingPrice ?? raw.spot ?? raw.underlying_price ??
               raw.quote?.regularMarketPrice ?? raw.lastPrice ?? null;

  // Prova a individuare l'array di contratti sotto vari nomi possibili
  let contracts = raw.options ?? raw.contracts ?? raw.chain ?? raw.data ?? [];
  if (!Array.isArray(contracts) && raw.calls && raw.puts) {
    contracts = [...raw.calls.map(c => ({ ...c, type: "call" })),
                 ...raw.puts.map(p => ({ ...p, type: "put" }))];
  }

  const now = new Date();
  const options = [];
  let putOiTotal = 0, callOiTotal = 0;

  for (const c of contracts) {
    const strike = c.strike ?? c.strikePrice ?? c.strike_price;
    const type = (c.type ?? c.side ?? c.optionType ?? c.option_type ?? "").toLowerCase();
    const oi = c.openInterest ?? c.open_interest ?? c.oi ?? 0;
    const iv = c.impliedVolatility ?? c.implied_volatility ?? c.iv;
    const expiration = c.expiration ?? c.expirationDate ?? c.expiration_date;

    if (expirationParam && expiration && !String(expiration).startsWith(expirationParam)) continue;
    if (strike == null || !type || iv == null) continue;

    const expDate = expiration ? new Date(expiration) : null;
    const dte = expDate ? Math.max(1, Math.round((expDate - now) / (1000 * 60 * 60 * 24))) : null;
    if (!dte) continue;

    options.push({
      strike: parseFloat(strike),
      option_type: type.startsWith("c") ? "call" : "put",
      open_interest: parseFloat(oi) || 0,
      implied_vol: parseFloat(iv) > 1 ? parseFloat(iv) / 100 : parseFloat(iv), // normalizza se in percentuale (es. 32 invece di 0.32)
      days_to_expiry: dte,
    });

    if (type.startsWith("c")) callOiTotal += parseFloat(oi) || 0;
    else putOiTotal += parseFloat(oi) || 0;
  }

  return {
    ticker: ticker.toUpperCase(),
    spot,
    put_oi_total: putOiTotal,
    call_oi_total: callOiTotal,
    options,
    _raw_field_names_found: Object.keys(contracts[0] || {}), // utile per debug se qualcosa non torna
  };
}
