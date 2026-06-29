/**
 * Step 1 — Busca a lista completa de Pokémons e divide em batches para o Map state.
 *
 * Usa /pokemon-species (não /pokemon) para obter os 1025 pokémons base,
 * evitando variantes de forma que duplicariam entradas.
 *
 * Saída: { batches: [{ batchIndex: 0, items: [{ name, url }] }, ...], total: 1025 }
 */

const POKE_API = "https://pokeapi.co/api/v2/pokemon-species?limit=1025";
const BATCH_SIZE = 50; // 21 batches de 50 pokémons cada

export const handler = async () => {
  const response = await fetch(POKE_API);

  if (!response.ok) {
    throw new Error(`PokeAPI retornou ${response.status} ao buscar lista`);
  }

  const { results } = await response.json();

  const batches = [];
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    batches.push({
      batchIndex: Math.floor(i / BATCH_SIZE),
      items: results.slice(i, i + BATCH_SIZE), // [{ name, url }]
    });
  }

  return { batches, total: results.length };
};
