/**
 * Step 2 — Invocada pelo Map state para cada batch.
 * Busca detalhes de até 50 Pokémons em paralelo via Promise.all.
 *
 * Alguns Pokémons têm formas (wormadam-plant, deoxys-normal, etc.).
 * O endpoint /pokemon-species retorna o nome base, mas /pokemon só aceita
 * o nome com a forma. Quando ocorre 404, buscamos a species para descobrir
 * a variedade padrão (is_default: true) e tentamos novamente.
 *
 * Input: { batchIndex: 0, items: [{ name, url }] }
 * Saída: { pokemon: [{ id, name, height, weight, base_experience, types, abilities }] }
 */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url);

    if (res.ok) return { data: await res.json(), notFound: false };
    if (res.status === 404) return { data: null, notFound: true };

    const isRetryable = res.status === 502 || res.status === 503 || res.status === 429;
    if (isRetryable && attempt < maxAttempts) {
      await delay(500 * attempt);
      continue;
    }

    throw new Error(`PokeAPI retornou ${res.status} para ${url} (tentativa ${attempt}/${maxAttempts})`);
  }
}

export const handler = async ({ batchIndex, items }) => {
  const pokemon = await Promise.all(
    items.map(async ({ name, url }) => {
      // Tenta pelo nome direto primeiro
      let { data: d, notFound } = await fetchJson(`https://pokeapi.co/api/v2/pokemon/${name}`);

      if (notFound) {
        // Pokémon tem formas — busca a species para achar a variedade padrão
        const { data: species } = await fetchJson(url);
        if (!species) throw new Error(`Não foi possível buscar species para ${name}`);

        const defaultVariety = species.varieties.find((v) => v.is_default);
        if (!defaultVariety) throw new Error(`Nenhuma variedade padrão encontrada para ${name}`);

        const { data: variety } = await fetchJson(defaultVariety.pokemon.url);
        if (!variety) throw new Error(`Não foi possível buscar variedade padrão de ${name}`);
        d = variety;
      }

      return {
        id: d.id,
        name: d.name,
        height: d.height,
        weight: d.weight,
        base_experience: d.base_experience ?? 0,
        types: d.types.map((t) => t.type.name).join('|'),
        abilities: d.abilities.map((a) => a.ability.name).join('|'),
      };
    })
  );

  console.log(`Batch ${batchIndex}: ${pokemon.length} pokémons processados`);

  return { pokemon };
};
