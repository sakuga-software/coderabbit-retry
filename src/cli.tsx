#!/usr/bin/env node
import { render } from "ink";
import meow from "meow";
import { App } from "./app.js";

const DEFAULT_ORG = "sakuga-software";

const cli = meow(
  `
  Relance « @coderabbitai review » sur tes PR ouvertes dont le quota CodeRabbit est revenu.

  Usage
    $ coderabbit-retry [options]

  Options
    -s, --since <AAAA-MM-JJ>  PR créées depuis cette date      (défaut : lundi de cette semaine)
    -o, --org <org>           Organisation GitHub               (défaut : ${DEFAULT_ORG})
    -a, --author <login>      Auteur des PR                     (défaut : @me)
    -w, --watch               Reste ouvert et relance chaque PR dès que son quota revient
    -n, --dry-run             Affiche les décisions sans poster de commentaire
    -h, --help                Affiche cette aide
        --version             Affiche la version

  États
    à jour        CodeRabbit a déjà reviewé le dernier commit
    en cours      le résumé de CodeRabbit affiche une review en cours
    quota         le quota n'est pas revenu ; affiche l'heure de retour
    demandée      un « @coderabbitai review » seul, de moins de 15 min, attend sa réponse
    rien à faire  dernier commit non reviewé, mais sans rate limit actif
    à relancer    le quota est revenu : poste « @coderabbitai review » seul

  Le délai vient de la version courante du commentaire de CodeRabbit : son
  « available in … » part de sa dernière modification. Le quota est commun
  à l'org, donc les relances partent une par une, chacune après la réponse
  de la précédente.

  Exemples
    $ coderabbit-retry
    $ coderabbit-retry --watch
    $ coderabbit-retry --dry-run --since 2026-09-15

  Prérequis : gh authentifié (gh auth status).
`,
  {
    importMeta: import.meta,
    description: false,
    allowUnknownFlags: false,
    flags: {
      since: { type: "string", shortFlag: "s" },
      org: { type: "string", shortFlag: "o", default: DEFAULT_ORG },
      author: { type: "string", shortFlag: "a", default: "@me" },
      watch: { type: "boolean", shortFlag: "w", default: false },
      dryRun: { type: "boolean", shortFlag: "n", default: false },
      help: { type: "boolean", shortFlag: "h" },
    },
  },
);

function mondayOfThisWeek(): string {
  const day = new Date();
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

const since = cli.flags.since ?? mondayOfThisWeek();
if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since))) {
  console.error(`--since attend une date AAAA-MM-JJ, reçu « ${since} ».`);
  process.exit(2);
}

const app = render(<App options={{ ...cli.flags, since }} />);
try {
  await app.waitUntilExit();
} catch {
  process.exitCode = 1;
}
