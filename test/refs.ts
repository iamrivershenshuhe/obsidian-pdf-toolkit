// Node test for src/pdf/references.ts
import { parseReferences, citationAt, resolveCitation, scholarUrl } from "../src/pdf/references";

let failures = 0;
function check(name: string, ok: boolean, info = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? " -> " + info : ""}`);
}

const body = `Introduction
Knowledge tracing [1] models student learning. Attention-based models [2, 3] and
forgetting-aware variants [4–6] have been proposed (Piech et al., 2015). We follow [3].`;

const numbered = [
  body,
  `Conclusion
We showed things.
References
[1] A. T. Corbett and J. R. Anderson, "Knowledge tracing: Modeling the acquisition of procedural knowledge," User Modeling and User-Adapted Interaction, vol. 4, no. 4, pp. 253–278, 1994. doi:10.1007/BF01099821
[2] C. Piech, J. Bassen, J. Huang, S. Ganguli, M. Sahami, L. J. Guibas, and J. Sohl-Dickstein, "Deep knowledge
tracing," in Advances in Neural Information Processing Systems, 2015, pp. 505–513.
[3] A. Ghosh, N. Heffernan, and A. S. Lan, "Context-aware attentive knowledge tracing," in Proc. KDD, 2020.
[4] S. Pandey and G. Karypis, "A self-attentive model for knowledge tracing," arXiv preprint arXiv:1907.06837, 2019.`,
  `[5] H. Nakagawa, Y. Iwasawa, and Y. Matsuo, "Graph-based knowledge tracing," in WI, 2019, pp. 156–163.
[6] Z. Liu et al., "pyKT: A python library," https://github.com/pykt-team/pykt-toolkit, 2022.
Appendix A
Extra material.`,
];

const list = parseReferences(numbered)!;
check("numbered list parsed", !!list && list.numbered, list ? `${list.entries.length} entries, start p.${list.startPage}` : "");
check("6 entries", list?.entries.length === 6);
check("entry 2 spans a line break", /Deep knowledge tracing/.test(list.entries[1].text), list.entries[1].title);
check("doi extracted", list.entries[0].doi === "10.1007/BF01099821", list.entries[0].doi);
check("arxiv extracted", list.entries[3].arxiv === "1907.06837", list.entries[3].arxiv);
check("url extracted", list.entries[5].url === "https://github.com/pykt-team/pykt-toolkit", list.entries[5].url);
check("quoted title", list.entries[2].title === "Context-aware attentive knowledge tracing", list.entries[2].title);
check("page of entry 5", list.entries[4].page === 3);
check("appendix stops list", !list.entries.some((e) => /Extra material/.test(e.text)));

const c1 = citationAt(body, body.indexOf("[2, 3]") + 2)!;
check("citation [2, 3]", !!c1 && JSON.stringify(c1.numbers) === "[2,3]", c1?.raw);
const c2 = citationAt(body, body.indexOf("[4–6]") + 1)!;
check("range [4–6]", !!c2 && JSON.stringify(c2.numbers) === "[4,5,6]", c2?.raw);
check("resolve [4–6]", resolveCitation(list, c2).map((e) => e.num).join(",") === "4,5,6");
check("no citation on plain text", citationAt(body, body.indexOf("models student")) === null);
const c3 = citationAt(body, body.indexOf("Piech et al") + 3)!;
check("author-year citation", !!c3 && c3.authorYear?.[0].surname === "Piech" && c3.authorYear?.[0].year === "2015", c3?.raw);
check("scholar url uses title", scholarUrl(list.entries[2]).includes("Context-aware"), scholarUrl(list.entries[2]).slice(0, 80));

// author-year list
const apa = [
  `Text (Smith & Jones, 2020) and more (Doe et al., 2019).`,
  `References
Doe, J., Roe, R., & Poe, P. (2019). A study of things that matter. Journal of Stuff, 12(3), 45–67. https://doi.org/10.1000/xyz123
Smith, A., & Jones, B. (2020). Another study with a long
title spanning lines. In Proceedings of Conf (pp. 1–10).
Zed, Z. (2018). Third entry here. Publisher.`,
];
const l2 = parseReferences(apa)!;
check("author-year list parsed", !!l2 && !l2.numbered, l2 ? `${l2.entries.length} entries` : "");
check("apa title", l2?.entries[0].title === "A study of things that matter", l2?.entries[0].title);
const c4 = citationAt(apa[0], apa[0].indexOf("Doe et al") + 2)!;
check("resolve author-year", resolveCitation(l2, c4)[0]?.firstAuthor === "Doe", resolveCitation(l2, c4)[0]?.key);
const c5 = citationAt(apa[0], apa[0].indexOf("Smith & Jones") + 8)!;
check("resolve Smith & Jones 2020", resolveCitation(l2, c5)[0]?.year === "2020", resolveCitation(l2, c5)[0]?.key);

console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
process.exit(failures ? 1 : 0);
