#!/usr/bin/env bash
#
# aider-stub.sh — faux binaire `aider`, injecté par la variable AIDER_CLI.
#
# C'est ce stub qui rend les lots 3b et 3c vérifiables sans clé DeepSeek et sans
# réseau. Comportement par défaut : il écrit un fichier connu dans le dépôt
# courant (le répertoire de travail, comme le vrai aider), journalise son argv
# dans un fichier, et sort en 0.
#
# Il n'écrit jamais rien en dehors du répertoire de travail, sauf son journal.
#
# ─── Variables de scénario ────────────────────────────────────────────────────
#
#   AIDER_STUB_SCENARIO   Scénario. Valeurs reconnues :
#
#     nominal (défaut)   Ajoute une ligne à AIDER_STUB_FICHIER. Un appel = une
#                        modification, donc un commit possible à chaque tour de
#                        boucle (indispensable au test MAX_ITERATIONS=2 : sans
#                        cela, le deuxième tour ne produirait aucun diff).
#
#     rien               N'écrit aucun fichier, sort en 0. C'est le chemin R4 :
#                        aucune modification proposée -> aucune PR, code 0.
#
#     echec              N'écrit rien, écrit un message d'erreur sur stderr et
#                        sort en AIDER_STUB_CODE_SORTIE (défaut 1). Simule une
#                        clé refusée (401), un crédit épuisé (402) ou un
#                        plantage Python -> arrêt immédiat, échec technique.
#
#     workflow           Écrit AIDER_STUB_FICHIER (autorisé) ET
#                        « .github/workflows/ci.yml » (interdit). R3 : le chemin
#                        interdit doit être refusé et absent de
#                        `git log --name-only`, tandis que le fichier autorisé
#                        est bien commité.
#
#     conf-aider         Écrit AIDER_STUB_FICHIER (autorisé) ET
#                        « .aider.conf.yml » (interdit). R8 : une configuration
#                        déposée au tour 1 serait chargée au tour 2.
#
#     interdits-seuls    Écrit uniquement « .github/workflows/ci.yml » et
#                        « .aider.conf.yml », rien d'autorisé. Tout est refusé,
#                        donc aucun commit : R3 + R8 croisés avec R4.
#
#   AIDER_STUB_FICHIER       Chemin du fichier autorisé écrit par les scénarios
#                            nominal / workflow / conf-aider, relatif au
#                            répertoire de travail. Défaut :
#                            « resultat-aider.txt ».
#
#   AIDER_STUB_CHEMINS_SUPP  Chemins supplémentaires à écrire, séparés par des
#                            espaces. Permet d'exercer un chemin interdit de la
#                            liste du lot 3b sans ajouter de scénario.
#
#   AIDER_STUB_SORTIE        Texte écrit sur stdout à la place de la sortie par
#                            défaut. Sert à faire remonter un motif dans le
#                            compte rendu (« rien à faire », par exemple).
#
#   AIDER_STUB_CODE_SORTIE   Code de sortie du scénario « echec ». Défaut : 1.
#
#   AIDER_STUB_JOURNAL       Fichier où l'argv de chaque appel est journalisé.
#                            Défaut : "${TMPDIR:-/tmp}/aider-stub-journal".
#                            Volontairement hors du dépôt : un journal écrit
#                            dans le répertoire de travail polluerait
#                            `git status` et fausserait les tests de commit.
#                            Chaque test doit en fixer un qui lui est propre.
#
# Tous les chemins écrits le sont en AJOUT (>>). Si le fichier est déjà suivi
# par git, l'appel produit une modification ; sinon, une création. Les deux
# branches de restauration du lot 3b (`git checkout --` pour un suivi modifié,
# suppression pour un non-suivi créé) sont donc atteignables avec le même stub,
# selon ce que le dépôt jetable du test contient déjà.
#
# ─── Format du journal ────────────────────────────────────────────────────────
#
# Un appel = les arguments séparés par un octet NUL (\0), suivis d'un octet
# « record separator » (\036). Ni échappement ni guillemets : la consigne passée
# en `--message`, qui contient des retours à la ligne, est restituée telle
# quelle — c'est ce qui permet de vérifier R6 (le bloc <!-- … --> doit être
# absent du prompt construit). Lecture côté Node :
#
#   const appels = fs.readFileSync(journal, 'utf8')
#     .split('\x1e').filter(Boolean)
#     .map(r => r.split('\0').filter(s => s !== ''));
#   const consigne = appels[0][appels[0].indexOf('--message') + 1];
#
# `appels.length` est le nombre d'appels à aider : c'est le compteur du test
# MAX_ITERATIONS=2. Un résumé lisible part aussi sur stderr.

set -uo pipefail

journal="${AIDER_STUB_JOURNAL:-${TMPDIR:-/tmp}/aider-stub-journal}"
mkdir -p "$(dirname "$journal")" 2>/dev/null || true
{ printf '%s\0' "$@"; printf '\036'; } >>"$journal"

# Numéro de cet appel = nombre de séparateurs d'enregistrement dans le journal.
appel="$(tr -cd '\036' <"$journal" | wc -c | tr -d ' ')"

printf 'aider-stub: appel %s dans %s : %s\n' "$appel" "$PWD" "$*" >&2

scenario="${AIDER_STUB_SCENARIO:-nominal}"
fichier="${AIDER_STUB_FICHIER:-resultat-aider.txt}"

ecrire() {
  chemin="$1"
  repertoire="$(dirname "$chemin")"
  [ "$repertoire" != "." ] && mkdir -p "$repertoire"
  printf '# écrit par aider-stub.sh, appel %s\n' "$appel" >>"$chemin"
  printf 'aider-stub: écrit %s\n' "$chemin" >&2
}

if [ "$scenario" = "echec" ]; then
  printf 'aider-stub: échec simulé (scénario « echec »)\n' >&2
  printf "litellm.AuthenticationError: AuthenticationError: DeepSeekException - Error code: 401\n" >&2
  exit "${AIDER_STUB_CODE_SORTIE:-1}"
fi

case "$scenario" in
  rien)
    : # aucun fichier écrit — chemin R4
    ;;
  nominal)
    ecrire "$fichier"
    ;;
  workflow)
    ecrire "$fichier"
    ecrire ".github/workflows/ci.yml"
    ;;
  conf-aider)
    ecrire "$fichier"
    ecrire ".aider.conf.yml"
    ;;
  interdits-seuls)
    ecrire ".github/workflows/ci.yml"
    ecrire ".aider.conf.yml"
    ;;
  *)
    printf 'aider-stub: scénario inconnu « %s »\n' "$scenario" >&2
    exit 2
    ;;
esac

for chemin_supp in ${AIDER_STUB_CHEMINS_SUPP:-}; do
  ecrire "$chemin_supp"
done

if [ -n "${AIDER_STUB_SORTIE:-}" ]; then
  printf '%s\n' "$AIDER_STUB_SORTIE"
else
  printf 'Aider v0.86.2 (aider-stub)\n'
  if [ "$scenario" = "rien" ]; then
    printf "Aucune modification nécessaire : le dépôt est déjà conforme.\n"
  else
    printf 'Applied edit (appel %s)\n' "$appel"
  fi
fi

exit 0
