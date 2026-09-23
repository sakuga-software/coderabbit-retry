# coderabbit-retry

Relance `@coderabbitai review` sur tes PR ouvertes dont le quota CodeRabbit est revenu.

![Démo de coderabbit-retry --watch sur des données simulées](docs/demo.gif)

Quand le quota de l'org est épuisé, CodeRabbit remplace sa review par un
« Review limit reached » avec un délai. Cet outil relit chaque PR, calcule
l'heure de retour du quota et poste la commande quand elle est passée.

## Installation

```sh
git clone git@github.com:sakuga-software/coderabbit-retry.git
cd coderabbit-retry
pnpm install          # build dist/ avec le script prepare
ln -sf "$PWD/dist/cli.js" ~/.local/bin/coderabbit-retry
```

Prérequis : Node ≥ 22 et `gh` authentifié (`gh auth status`).

## Usage

```sh
coderabbit-retry              # relance ce qui peut l'être, puis quitte
coderabbit-retry --watch      # reste ouvert et relance dès que le quota revient
coderabbit-retry --dry-run    # affiche les décisions sans rien poster
coderabbit-retry --help       # options et états
```

## Règles de décision

- Le délai vient de la **version courante** du commentaire de CodeRabbit.
  Son « available in … » part de sa dernière modification (`updated_at`).
- Seul un commentaire `@coderabbitai review` **seul** compte comme une demande.
  Avec du texte en plus, CodeRabbit le traite comme une discussion et ne lance pas de review.
- Une demande sans réponse depuis plus de 15 min ne bloque plus la relance.
- Un rate limit est levé si une review ou un « Review triggered » arrive après lui.
- Si le délai est illisible, l'outil suppose 1 h.
- Le quota est commun à l'org : les relances partent une par une, chacune après
  la réponse de la précédente. Un nouveau rate limit met les autres PR en attente.

## Développement

```sh
pnpm dev -- --dry-run   # lance les sources avec tsx
pnpm test               # tests de la logique de décision
pnpm typecheck
```

## Démo

Le GIF passe par la vraie interface et la vraie logique de décision, avec un faux
GitHub (`demo/demo.tsx`) qui déroule une chronologie : une review en cours, un quota
qui revient, une relance, puis la review. Pour le réenregistrer (vhs, ttyd et ffmpeg) :

```sh
demo/record.sh
```
