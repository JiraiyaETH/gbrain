# Source Ledger

## Search log (acquisition completed 2026-07-15T08:54:46+07:00; cap = 8 included strong sources)

| Time | Lane | Query / URL | Tool | Result | Include? | Reason |
|---|---|---|---|---|---|---|
| 08:51:09 | Brain | `gbrain search ...anchoring...` | terminal / gbrain | No results | baseline | Read-only Brain-first lookup; absence is not evidence of novelty |
| 08:51:09 | Brain | `gbrain query ...Brain context...` | terminal / gbrain | No results | baseline | No direct internal comparison study |
| 08:51:09 | Brain | `gbrain search "agentic research"` + get skill | terminal / gbrain | Agentic Research System skill and changelog | context | Procedure/claims only, not empirical evidence |
| 08:52 | Human search | anchoring + confirmation bias + information search | web_search | Lau et al. PMC study; Azzopardi review; related results | yes | Discovery, then bodies retrieved independently |
| 08:52 | LLM factuality | retrieval augmented generation factuality | web_search | Lewis RAG; Self-RAG | yes | Primary papers; body retrieved via requests/pypdf |
| 08:52 | Context use | long context position and context conflict | web_search | Lost in the Middle; Blinded by Generated Contexts | yes | Primary experiments; body retrieved via ACL/arXiv HTML |
| 08:53 | Research design | multi-perspective question asking | web_search | Stanford STORM project page | yes | Official project page describing method and evaluation |
| 08:53 | Conflict lane | RALM internal/external knowledge conflict | web_search | Tug-of-War Between Knowledge (arXiv:2402.14409) | yes | Primary conflict experiments; body retrieved via pypdf |
| 08:54 | Evidence audit | source bodies for all included sources | terminal requests + BeautifulSoup/pypdf | Bodies/abstracts/sections read; no snippet-only citation used | pass | Search snippets used only for discovery |

## Included sources

| ID | Title / publisher | URL | Class / authority | Date | Supports | Caveats |
|---|---|---|---|---|---|---|---|
| S1 | Lau & Coiera, “Do People Experience Cognitive Biases while Searching for Information?”, Journal of the American Medical Informatics Association / PMC | https://pmc.ncbi.nlm.nih.gov/articles/PMC1975788/ | empirical human search study / primary | 2007 | C4: prior belief significantly predicted post-search answer; order/exposure effects also observed in prospective sample | Health-search tasks; human participants, not LLMs; anchoring is correlation with pre/post answers, not a Brain-injection experiment |
| S2 | Azzopardi, “Cognitive Biases in Search: A Review and Reflection of Cognitive Biases in Information Retrieval,” ACM CHIIR | https://strathprints.strath.ac.uk/75111/1/Azzopardi_CHIIR_2021_Cognitive_biases_in_search_a_review_and_reflection_of_cognitive_biases_in_information_retrieval.pdf | review / secondary, authoritative venue | 2021 | C4, C6, C8: >30 empirical studies; anchoring, confirmation, exposure and position effects; biases can compound, but positive effects are possible and evidence is heterogeneous | Perspective review, not a systematic meta-analysis; findings are tendencies, not universal effects |
| S3 | Lewis et al., “Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks,” NeurIPS | https://papers.nips.cc/paper/2020/file/6b493230205f780e1bc26945df7481e5-Paper.pdf | benchmark/method paper / primary | 2020 | C2: external non-parametric memory improved open-domain QA and human-rated factuality/specificity versus parametric-only BART; supports inspectable/updatable knowledge | Trained RAG model over Wikipedia, not arbitrary Brain prompt injection; results are task/model/corpus-specific |
| S4 | Asai et al., “Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection,” ICLR | https://proceedings.iclr.cc/paper_files/paper/2024/hash/25f7be9694d7b32d5cc670927b8091e1-Abstract-Conference.html (paper: https://arxiv.org/pdf/2310.11511v1) | benchmark/method paper / primary | 2024 | C2, C3, C8: on-demand retrieval plus relevance/factuality critique outperformed fixed retrieval baselines; indiscriminate/off-topic context can hurt quality and versatility | Learned model and benchmark setting; does not directly test a personal Brain or human researcher |
| S5 | Liu et al., “Lost in the Middle: How Language Models Use Long Contexts,” TACL / ACL Anthology | https://aclanthology.org/2024.tacl-1.9/ | controlled model study / primary | 2024 | C3, C8: context position materially changes accuracy; U-shaped primacy/recency; more retrieved documents can saturate or reduce useful performance | Older model versions and controlled QA; position sensitivity does not by itself prove belief reinforcement |
| S6 | Tan et al., “Blinded by Generated Contexts: How Language Models Merge Generated and Retrieved Contexts When Knowledge Conflicts?”, arXiv | https://arxiv.org/html/2401.11911v6 | controlled conflict study / primary | 2024 | C5, C8: GPT-3.5/4 and Llama2 favored generated, semantically similar but incorrect contexts over correct retrieved contexts; semantic completeness and similarity affected selection | Preprint; generated-vs-retrieved conflict differs from Brain-vs-web conflict, but is a close mechanism analogue |
| S7 | Shao et al., Stanford STORM project, NAACL 2024 | https://storm-project.stanford.edu/research/storm/ | system paper/project description / primary project source | 2024 | C6, C8: diverse perspectives and simulated question-answering improved breadth/organization over a retrieval baseline; expert feedback identified source-bias transfer and red herrings | Project page summarizes results; not a direct Brain-first versus blind comparison |
| S8 | “Tug-of-War Between Knowledge: Exploring and Resolving Knowledge Conflicts in Retrieval-Augmented Language Models,” arXiv:2402.14409 | https://arxiv.org/pdf/2402.14409 | conflict benchmark/method paper / primary | 2024 | C5, C8: RALMs sometimes favored faulty internal memory even with correct evidence; majority-frequency and consistency effects; CD² calibration reduced conflicts in evaluated open models | Preprint; specific RALM setup and open-model logits; black-box/general-agent transfer is uncertain |

## Rejected / discovery-only sources

| Title | URL | Reason rejected | Could still be useful for |
|---|---|---|---|
| Nickerson, “Confirmation Bias: A Ubiquitous Phenomenon in Many Guises” | https://journals.sagepub.com/doi/10.1037/1089-2680.2.2.175 | Publisher page returned 403 in this run; search snippet only, so not used as support | Background definition after retrieving accessible full text |
| “Fifty Years of Anchoring Effects: A Theoretical Reintegration and Meta-Analysis” | https://doi.org/10.1287/mnsc.2023.03238 | Discovery result exposed an abstract snippet but full body was not retrieved within the bounded acquisition window; not used as source support | Stronger general anchoring magnitude estimate in a follow-up run |
| 2026 “Confirmation, Framing, and Position Biases in LLM Responses” | https://dl.acm.org/doi/10.1145/3786304.3787879 | Search result is future-dated relative to the run and full body was not read; not needed because older primary evidence sufficed | Current LLM-bias replication, subject to publication/access verification |

## Evidence gaps and follow-ups

| Gap | Why it matters | Follow-up query/source | Decision impact |
|---|---|---|---|
| No direct randomized Brain-first vs Brain-blind comparison | Cannot quantify net novelty or accuracy effect of this exact workflow | Build paired benchmark with same questions, Brain packet on/off, randomized source order | Required before claiming Brain-first is net superior |
| Human researcher and LLM effects are conflated in available literature | Human anchoring evidence may not transfer one-to-one to agents | Controlled agent study with context packet, source provenance, and blind reviewer | Determines whether safeguards must target prompt order, retrieval, or human review |
| Novelty is underdefined in literature | “New relative to Brain” differs from “new to the world” | Measure new-to-Brain, new-to-corpus, and decision-useful novelty separately | Prevents novelty inflation from a thin/empty Brain |
| Source quality and Brain staleness vary | Relevant but stale/misleading context can lower factuality | Freshness-aware provenance and contradiction benchmark | Determines when to suppress or downgrade Brain context |
