/**
 * Step 3 — Recebe todos os batches do Map state, gera o CSV,
 * faz upload para S3 e retorna uma presigned URL válida por 5 minutos.
 *
 * Input:
 * {
 *   batchResults: [{ pokemon: [...] }, ...],  // saída acumulada do Map state
 *   total: 1154
 * }
 *
 * Saída:
 * { downloadUrl: "https://...", filename: "pokemon-export-xxx.csv", totalRecords: 1154 }
 *
 * Variáveis de ambiente necessárias:
 *   CSV_BUCKET — nome do bucket S3 onde o CSV será armazenado
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});
const BUCKET = process.env.CSV_BUCKET;
const PRESIGN_TTL_SECONDS = 300; // 5 minutos

const CSV_HEADERS = [
  'id',
  'name',
  'height',
  'weight',
  'base_experience',
  'types',
  'abilities',
];

function toCsv(rows) {
  const escape = (val) => {
    const str = String(val ?? '');
    return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const header = CSV_HEADERS.join(',');
  const lines = rows.map((row) => CSV_HEADERS.map((col) => escape(row[col])).join(','));

  return [header, ...lines].join('\n');
}

export const handler = async ({ batchResults, total }) => {
  if (!BUCKET) throw new Error('Variável de ambiente CSV_BUCKET não definida');

  // Achata o array de arrays e ordena por ID
  const allPokemon = batchResults
    .flatMap((b) => b.pokemon)
    .sort((a, b) => a.id - b.id);

  const csv = toCsv(allPokemon);
  const filename = `pokemon-export-${Date.now()}.csv`;
  const s3Key = `exports/${filename}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      Body: csv,
      ContentType: 'text/csv',
      ContentDisposition: `attachment; filename="${filename}"`,
    })
  );

  // Presigned URL — o navegador inicia o download automaticamente ao acessá-la
  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }),
    { expiresIn: PRESIGN_TTL_SECONDS }
  );

  console.log(`CSV gerado: ${s3Key} (${allPokemon.length} registros)`);

  return {
    downloadUrl,
    filename,
    totalRecords: allPokemon.length,
  };
};
