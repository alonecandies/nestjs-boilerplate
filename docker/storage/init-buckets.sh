#!/bin/sh
# One-shot bucket bootstrapper: the `storage-init` compose service (rustfs image, for its curl).
# Idempotent: "already exists" counts as success.
#  - S3 (RustFS):             PUT /<bucket> signed with SigV4 (curl --aws-sigv4, curl >= 7.75)
#  - GCS (fake-gcs-server):   JSON API POST /storage/v1/b -> 200 created / 409 exists
# Bucket names must match the apps' S3_BUCKET / GCS_BUCKET (both default to "uploads").
set -eu

S3_ENDPOINT="${S3_ENDPOINT:-http://rustfs:9000}"
S3_REGION="${S3_REGION:-us-east-1}"
GCS_ENDPOINT="${GCS_ENDPOINT:-http://gcs:4443}"
GCS_PROJECT="${GCS_PROJECT_ID:-local-project}"

for bucket in ${S3_BUCKETS:-}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    --aws-sigv4 "aws:amz:${S3_REGION}:s3" --user "${S3_ACCESS_KEY}:${S3_SECRET_KEY}" \
    -X PUT "${S3_ENDPOINT}/${bucket}")
  echo "[storage-init] s3  bucket ${bucket}: HTTP ${code}"
  case "${code}" in 200 | 409) ;; *) exit 1 ;; esac
  # Assert it is really there (HEAD bucket = 200).
  code=$(curl -s -o /dev/null -w '%{http_code}' -I \
    --aws-sigv4 "aws:amz:${S3_REGION}:s3" --user "${S3_ACCESS_KEY}:${S3_SECRET_KEY}" \
    "${S3_ENDPOINT}/${bucket}")
  [ "${code}" = 200 ] || { echo "[storage-init] s3 bucket ${bucket} not found (HTTP ${code})" >&2; exit 1; }
done

for bucket in ${GCS_BUCKETS:-}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
    -d "{\"name\":\"${bucket}\"}" "${GCS_ENDPOINT}/storage/v1/b?project=${GCS_PROJECT}")
  echo "[storage-init] gcs bucket ${bucket}: HTTP ${code}"
  case "${code}" in 200 | 409) ;; *) exit 1 ;; esac
  code=$(curl -s -o /dev/null -w '%{http_code}' "${GCS_ENDPOINT}/storage/v1/b/${bucket}")
  [ "${code}" = 200 ] || { echo "[storage-init] gcs bucket ${bucket} not found (HTTP ${code})" >&2; exit 1; }
done
echo "[storage-init] done"
