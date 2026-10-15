#!/usr/bin/env bash
# Starts the real servers the integration tests run against, and seeds them (idempotent).
#
#   bash __test__/integration/setup.sh
#   RAPIDD_IT=1 npx jest __test__/integration --forceExit
#   bash __test__/integration/setup.sh down     # remove the containers
#
# Redis 7 (:56379), OpenLDAP (:51389, no memberOf overlay — like many real installs),
# Keycloak 26 (:58080, realm "corp", confidential client "rapidd-api", user alice/alice-pass
# with realm role "admin"), PostgreSQL 16 (:56543, postgres/pw, database "app"), MariaDB 11
# (:53306, root/pw, database "app").
set -euo pipefail

if [[ "${1:-}" == "down" ]]; then
    docker rm -f rapidd-it-redis rapidd-it-ldap rapidd-it-kc rapidd-it-pg rapidd-it-mariadb >/dev/null 2>&1 || true
    echo "integration containers removed"
    exit 0
fi

ensure() { # name, docker run args...
    local name=$1; shift
    if [[ -z "$(docker ps -aq -f name="^${name}$")" ]]; then
        docker run -d --name "$name" "$@" >/dev/null
    elif [[ -z "$(docker ps -q -f name="^${name}$")" ]]; then
        docker start "$name" >/dev/null
    fi
}

ensure rapidd-it-redis -p 56379:6379 redis:7-alpine
ensure rapidd-it-ldap -p 51389:389 -e LDAP_ORGANISATION=Corp -e LDAP_DOMAIN=corp.example -e LDAP_ADMIN_PASSWORD=adminpw osixia/openldap:1.5.0
ensure rapidd-it-kc -p 58080:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak:26.4 start-dev
ensure rapidd-it-pg -p 56543:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=app postgres:16-alpine
ensure rapidd-it-mariadb -p 53306:3306 -e MARIADB_ROOT_PASSWORD=pw -e MARIADB_DATABASE=app mariadb:11

# ── OpenLDAP ────────────────────────────────────────────
LDAP=(docker exec rapidd-it-ldap)
for _ in $(seq 1 60); do
    "${LDAP[@]}" ldapsearch -x -H ldap://localhost -b dc=corp,dc=example -D cn=admin,dc=corp,dc=example -w adminpw -s base >/dev/null 2>&1 && break
    sleep 1
done
if ! "${LDAP[@]}" ldapsearch -x -H ldap://localhost -b ou=people,dc=corp,dc=example -D cn=admin,dc=corp,dc=example -w adminpw -s base >/dev/null 2>&1; then
    # -i: without it docker exec does not pass stdin, and the seed file would be empty
    docker exec -i rapidd-it-ldap sh -c 'cat > /tmp/seed.ldif' <<'LDIF'
dn: ou=people,dc=corp,dc=example
objectClass: organizationalUnit
ou: people

dn: ou=groups,dc=corp,dc=example
objectClass: organizationalUnit
ou: groups

dn: uid=alice,ou=people,dc=corp,dc=example
objectClass: inetOrgPerson
uid: alice
cn: Alice Doe
sn: Doe
displayName: Alice Doe
mail: alice@corp.example
userPassword: alice-pass

dn: uid=bob,ou=people,dc=corp,dc=example
objectClass: inetOrgPerson
uid: bob
cn: Bob, Jr.
sn: Bob
mail: bob@corp.example
userPassword: bob-pass

dn: cn=staff,ou=groups,dc=corp,dc=example
objectClass: groupOfNames
cn: staff
member: uid=alice,ou=people,dc=corp,dc=example
member: uid=bob,ou=people,dc=corp,dc=example

dn: cn=admins,ou=groups,dc=corp,dc=example
objectClass: groupOfNames
cn: admins
member: uid=alice,ou=people,dc=corp,dc=example
LDIF
    "${LDAP[@]}" ldapadd -x -H ldap://localhost -D cn=admin,dc=corp,dc=example -w adminpw -f /tmp/seed.ldif >/dev/null
    echo "ldap seeded"
fi

# ── Keycloak ────────────────────────────────────────────
KC=http://127.0.0.1:58080
for _ in $(seq 1 120); do
    curl -sf "$KC/realms/master/.well-known/openid-configuration" >/dev/null && break
    sleep 1
done
if ! curl -sf "$KC/realms/corp/.well-known/openid-configuration" >/dev/null; then
    TOKEN=$(curl -s -X POST "$KC/realms/master/protocol/openid-connect/token" \
        -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin \
        | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).access_token))")
    H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
    curl -sf -X POST "$KC/admin/realms" "${H[@]}" -d '{"realm":"corp","enabled":true}'
    curl -sf -X POST "$KC/admin/realms/corp/clients" "${H[@]}" -d '{
      "clientId":"rapidd-api","enabled":true,"publicClient":false,"secret":"rapidd-secret",
      "redirectUris":["http://rapidd.test/auth/keycloak/callback"],"standardFlowEnabled":true,"directAccessGrantsEnabled":true,
      "protocolMappers":[{"name":"aud","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper",
        "config":{"included.client.audience":"rapidd-api","access.token.claim":"true","id.token.claim":"false"}}]}'
    curl -sf -X POST "$KC/admin/realms/corp/roles" "${H[@]}" -d '{"name":"admin"}'
    curl -sf -X POST "$KC/admin/realms/corp/users" "${H[@]}" -d '{
      "username":"alice","email":"alice@example.com","emailVerified":true,"firstName":"Alice","lastName":"Doe","enabled":true,
      "credentials":[{"type":"password","value":"alice-pass","temporary":false}]}'
    USER_ID=$(curl -s "$KC/admin/realms/corp/users?username=alice" "${H[@]}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)[0].id))")
    ROLE=$(curl -s "$KC/admin/realms/corp/roles/admin" "${H[@]}")
    curl -sf -X POST "$KC/admin/realms/corp/users/$USER_ID/role-mappings/realm" "${H[@]}" -d "[$ROLE]"
    echo "keycloak provisioned"
fi

echo "integration environment ready — run: RAPIDD_IT=1 npx jest __test__/integration --forceExit"
