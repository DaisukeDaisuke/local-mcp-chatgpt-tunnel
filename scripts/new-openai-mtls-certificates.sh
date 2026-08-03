#!/bin/sh
set -eu

out=${1:-/out}
umask 077
mkdir -p "$out"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$out/openai_mtls_ca_key.pem"
openssl req -x509 -new -sha256 -days 365 \
  -key "$out/openai_mtls_ca_key.pem" \
  -subj "/CN=dq9-openai-mcp-local-ca" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" \
  -addext "authorityKeyIdentifier=keyid:always" \
  -out "$out/openai_mtls_ca_cert.pem"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$out/openai_mtls_client_key.pem"
openssl req -new -sha256 \
  -key "$out/openai_mtls_client_key.pem" \
  -subj "/CN=dq9-openai-mcp-client" \
  -addext "subjectAltName=URI:urn:dq9-openai-mcp-client" \
  -out "$out/openai_mtls_client.csr"

cat > "$out/openai_mtls_client.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=critical,clientAuth
subjectAltName=URI:urn:dq9-openai-mcp-client
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF

openssl x509 -req -sha256 -days 90 \
  -in "$out/openai_mtls_client.csr" \
  -CA "$out/openai_mtls_ca_cert.pem" \
  -CAkey "$out/openai_mtls_ca_key.pem" \
  -CAcreateserial \
  -extfile "$out/openai_mtls_client.ext" \
  -out "$out/openai_mtls_client_cert.pem"

rm -f "$out/openai_mtls_client.csr" "$out/openai_mtls_client.ext" "$out/openai_mtls_ca_cert.srl"
chmod 0600 "$out/openai_mtls_ca_key.pem" "$out/openai_mtls_client_key.pem"
chmod 0644 "$out/openai_mtls_ca_cert.pem" "$out/openai_mtls_client_cert.pem"
echo "Generated RSA-3072 CA and client certificates in $out"
echo "Upload only openai_mtls_ca_cert.pem to OpenAI. Never upload or commit either private key."
