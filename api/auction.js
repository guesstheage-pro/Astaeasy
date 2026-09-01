module.exports = async function(req, res) {
  // CORS configurazione per Vercel
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { CF_ACCOUNT_ID, CF_DB_ID, CF_API_TOKEN } = process.env;

  // FUNZIONE AGGIORNATA: Invia a Cloudflare le query una alla volta (come Oggetto, non come Array)
  async function executeD1(queries) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DB_ID}/query`;
    let results = [];
    
    for (const query of queries) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        // Qui sta il trucco: passiamo "query" (singolo oggetto) e non l'array completo
        body: JSON.stringify(query) 
      });
      
      const data = await response.json();
      if (!data.success) throw new Error(JSON.stringify(data.errors));
      
      if (data.result && data.result.length > 0) {
        results.push(data.result[0]);
      } else {
        results.push({ results: [] });
      }
    }
    return results;
  }

  try {
    const body = req.body || {};
    const action = body.action || req.query.action;

    if (action === 'GET_AUCTIONS') {
      const result = await executeD1([{ sql: "SELECT * FROM auctions ORDER BY created_at DESC", params: [] }]);
      return res.status(200).json(result[0].results || []);
    }

    if (action === 'CREATE_AUCTION') {
      const { id, name, budget, total_players, role_targets, role_percents } = body;
      await executeD1([{
        sql: "INSERT INTO auctions (id, name, budget, total_players, role_targets, role_percents) VALUES (?, ?, ?, ?, ?, ?)",
        params: [id, name, budget, total_players, JSON.stringify(role_targets), JSON.stringify(role_percents)]
      }]);
      return res.status(200).json({ success: true });
    }

    if (action === 'GET_AUCTION_DATA') {
      const { auctionId } = body;
      const results = await executeD1([
        { sql: "SELECT * FROM auctions WHERE id = ?", params: [auctionId] },
        { sql: "SELECT * FROM players WHERE auction_id = ?", params: [auctionId] },
        { sql: "SELECT * FROM purchases WHERE auction_id = ? ORDER BY timestamp ASC", params: [auctionId] }
      ]);
      
      if (!results[0].results || results[0].results.length === 0) return res.status(404).json({ error: 'Asta non trovata' });

      const config = results[0].results[0];
      return res.status(200).json({
        config: {
          ...config,
          role_targets: JSON.parse(config.role_targets),
          role_percents: JSON.parse(config.role_percents)
        },
        players: results[1].results || [],
        purchases: results[2].results || []
      });
    }

    if (action === 'IMPORT_PLAYERS') {
      const { auctionId, players } = body;
      let queries = [{ sql: "DELETE FROM players WHERE auction_id = ?", params: [auctionId] }];

      players.forEach(p => {
        queries.push({
          sql: "INSERT INTO players (id, auction_id, nome, squadra, ruolo, quotazione, stato, prezzo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [p.id, auctionId, p.nome, p.squadra, p.ruolo, p.quotazione, p.stato, p.prezzo || null]
        });
      });

      await executeD1(queries);
      return res.status(200).json({ success: true });
    }

    if (action === 'ADD_PURCHASE') {
      const { auctionId, purchase } = body;
      await executeD1([
        { sql: "UPDATE players SET stato = 'ACQUISTATO', prezzo = ? WHERE id = ? AND auction_id = ?", params: [purchase.prezzo, purchase.playerId, auctionId] },
        { sql: "INSERT INTO purchases (id, auction_id, player_id, prezzo, timestamp) VALUES (?, ?, ?, ?, ?)", params: [purchase.id, auctionId, purchase.playerId, purchase.prezzo, purchase.timestamp] }
      ]);
      return res.status(200).json({ success: true });
    }

    if (action === 'EDIT_PURCHASE') {
      const { auctionId, purchaseId, playerId, newPrezzo } = body;
      await executeD1([
        { sql: "UPDATE players SET prezzo = ? WHERE id = ? AND auction_id = ?", params: [newPrezzo, playerId, auctionId] },
        { sql: "UPDATE purchases SET prezzo = ? WHERE id = ? AND auction_id = ?", params: [newPrezzo, purchaseId, auctionId] }
      ]);
      return res.status(200).json({ success: true });
    }

    if (action === 'DELETE_PURCHASE') {
      const { auctionId, purchaseId, playerId } = body;
      await executeD1([
        { sql: "UPDATE players SET stato = 'DISPONIBILE', prezzo = NULL WHERE id = ? AND auction_id = ?", params: [playerId, auctionId] },
        { sql: "DELETE FROM purchases WHERE id = ? AND auction_id = ?", params: [purchaseId, auctionId] }
      ]);
      return res.status(200).json({ success: true });
    }

    if (action === 'DELETE_AUCTION') {
      const { auctionId } = body;
      await executeD1([{ sql: "DELETE FROM auctions WHERE id = ?", params: [auctionId] }]);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Azione non valida' });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
};