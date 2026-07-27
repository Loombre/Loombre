// SPDX-License-Identifier: AGPL-3.0-only
// Loombre :: packages/shared/src/language-codes.ts
//
// The ONE canonical known-language list for user_settings.prefs's
// audioPreferredLanguage/subtitlePreferredLanguage (H1, orchestrator
// adjudication A-1). packages/contract/openapi.yaml pins both fields to
// `pattern: '^[a-z]{3}$'` (shape only); MEMBERSHIP in this list is what the
// server actually validates against (apps/server/src/catalog/
// users.controller.ts's putMySettings) and what the web picker
// (apps/web/src/components/settings/sections/AccountSection.tsx) renders
// its options from — one data module, two consumers, so they cannot drift.
//
// Scope: ISO 639-2 codes for INDIVIDUAL languages only (both the
// bibliographic "B" and terminologic "T" code where the standard assigns
// two — see LANGUAGE_EQUIVALENCE_PAIRS below). Deliberately EXCLUDED:
//   - Collective/family codes (e.g. "gem" Germanic languages, "sla" Slavic
//     languages, "afa" Afro-Asiatic languages, "map" Austronesian
//     languages) — these describe a LANGUAGE GROUP, never a single audio or
//     subtitle track's language, so offering them as a "preference" would
//     be meaningless.
//   - The reserved-for-local-use range (qaa-qtz) — not a real language.
//   - The special codes "mul" (multiple languages), "mis" (uncoded
//     languages), "und" (undetermined), "zxx" (no linguistic content), and
//     "art" (artificial languages, collective) — none of these are
//     something a user would ever set as a PREFERENCE; "no preference" is
//     already `null` (see UserSettings' contract description).
// This keeps the list a genuine "pick the language you want" set rather
// than a byte-for-byte dump of the full ISO 639-2 registry, which also
// contains dozens of entries no real audio/subtitle stream is ever tagged
// with. Everything here is still a real, standard ISO 639-2 code — nothing
// invented.
//
// Dependency-free data + pure functions only (orchestrator adjudication
// A-1): no zod, no I/O, importable from both apps/server (validation) and
// apps/web (the picker) without dragging in either's runtime.

export interface LanguageCode {
  /** Lowercase ISO 639-2 code, exactly 3 letters — matches the contract's
   *  `pattern: '^[a-z]{3}$'` on both language preference fields. */
  code: string;
  /** English display name, as the ISO 639-2 registry names it. */
  name: string;
}

/**
 * ISO 639-2 individual-language codes with their English display names,
 * sorted by code. Where the standard assigns both a bibliographic (B) and
 * terminologic (T) code for the same language (see
 * LANGUAGE_EQUIVALENCE_PAIRS), BOTH codes appear here as separate entries
 * sharing the same `name` — both are independently valid stored values, and
 * languageMatches() (below) is what treats them as equivalent.
 */
export const LANGUAGE_CODES: readonly LanguageCode[] = [
  { code: "aar", name: "Afar" },
  { code: "abk", name: "Abkhazian" },
  { code: "ace", name: "Achinese" },
  { code: "ach", name: "Acoli" },
  { code: "ada", name: "Adangme" },
  { code: "ady", name: "Adyghe" },
  { code: "afh", name: "Afrihili" },
  { code: "afr", name: "Afrikaans" },
  { code: "ain", name: "Ainu" },
  { code: "aka", name: "Akan" },
  { code: "akk", name: "Akkadian" },
  { code: "alb", name: "Albanian" },
  { code: "ale", name: "Aleut" },
  { code: "alt", name: "Southern Altai" },
  { code: "amh", name: "Amharic" },
  { code: "ang", name: "Old English" },
  { code: "anp", name: "Angika" },
  { code: "ara", name: "Arabic" },
  { code: "arc", name: "Aramaic" },
  { code: "arg", name: "Aragonese" },
  { code: "arm", name: "Armenian" },
  { code: "arn", name: "Mapudungun" },
  { code: "arp", name: "Arapaho" },
  { code: "arw", name: "Arawak" },
  { code: "asm", name: "Assamese" },
  { code: "ast", name: "Asturian" },
  { code: "ava", name: "Avaric" },
  { code: "ave", name: "Avestan" },
  { code: "awa", name: "Awadhi" },
  { code: "aym", name: "Aymara" },
  { code: "aze", name: "Azerbaijani" },
  { code: "bak", name: "Bashkir" },
  { code: "bal", name: "Baluchi" },
  { code: "bam", name: "Bambara" },
  { code: "ban", name: "Balinese" },
  { code: "baq", name: "Basque" },
  { code: "bas", name: "Basa" },
  { code: "bej", name: "Beja" },
  { code: "bel", name: "Belarusian" },
  { code: "bem", name: "Bemba" },
  { code: "ben", name: "Bengali" },
  { code: "bho", name: "Bhojpuri" },
  { code: "bik", name: "Bikol" },
  { code: "bin", name: "Bini" },
  { code: "bis", name: "Bislama" },
  { code: "bla", name: "Siksika" },
  { code: "bod", name: "Tibetan" },
  { code: "bos", name: "Bosnian" },
  { code: "bra", name: "Braj" },
  { code: "bre", name: "Breton" },
  { code: "bua", name: "Buriat" },
  { code: "bug", name: "Buginese" },
  { code: "bul", name: "Bulgarian" },
  { code: "bur", name: "Burmese" },
  { code: "byn", name: "Blin" },
  { code: "cad", name: "Caddo" },
  { code: "car", name: "Galibi Carib" },
  { code: "cat", name: "Catalan" },
  { code: "ceb", name: "Cebuano" },
  { code: "ces", name: "Czech" },
  { code: "cha", name: "Chamorro" },
  { code: "chb", name: "Chibcha" },
  { code: "che", name: "Chechen" },
  { code: "chg", name: "Chagatai" },
  { code: "chi", name: "Chinese" },
  { code: "chk", name: "Chuukese" },
  { code: "chm", name: "Mari" },
  { code: "cho", name: "Choctaw" },
  { code: "chp", name: "Chipewyan" },
  { code: "chr", name: "Cherokee" },
  { code: "chu", name: "Church Slavic" },
  { code: "chv", name: "Chuvash" },
  { code: "chy", name: "Cheyenne" },
  { code: "cnr", name: "Montenegrin" },
  { code: "cop", name: "Coptic" },
  { code: "cor", name: "Cornish" },
  { code: "cos", name: "Corsican" },
  { code: "cre", name: "Cree" },
  { code: "crh", name: "Crimean Tatar" },
  { code: "csb", name: "Kashubian" },
  { code: "cym", name: "Welsh" },
  { code: "cze", name: "Czech" },
  { code: "dak", name: "Dakota" },
  { code: "dan", name: "Danish" },
  { code: "dar", name: "Dargwa" },
  { code: "del", name: "Delaware" },
  { code: "den", name: "Slave (Athapascan)" },
  { code: "deu", name: "German" },
  { code: "dgr", name: "Dogrib" },
  { code: "din", name: "Dinka" },
  { code: "div", name: "Divehi" },
  { code: "doi", name: "Dogri" },
  { code: "dsb", name: "Lower Sorbian" },
  { code: "dua", name: "Duala" },
  { code: "dum", name: "Middle Dutch" },
  { code: "dut", name: "Dutch" },
  { code: "dyu", name: "Dyula" },
  { code: "dzo", name: "Dzongkha" },
  { code: "efi", name: "Efik" },
  { code: "egy", name: "Ancient Egyptian" },
  { code: "eka", name: "Ekajuk" },
  { code: "elx", name: "Elamite" },
  { code: "ell", name: "Greek" },
  { code: "eng", name: "English" },
  { code: "enm", name: "Middle English" },
  { code: "epo", name: "Esperanto" },
  { code: "est", name: "Estonian" },
  { code: "eus", name: "Basque" },
  { code: "ewe", name: "Ewe" },
  { code: "ewo", name: "Ewondo" },
  { code: "fan", name: "Fang" },
  { code: "fao", name: "Faroese" },
  { code: "fas", name: "Persian" },
  { code: "fat", name: "Fanti" },
  { code: "fij", name: "Fijian" },
  { code: "fil", name: "Filipino" },
  { code: "fin", name: "Finnish" },
  { code: "fon", name: "Fon" },
  { code: "fra", name: "French" },
  { code: "fre", name: "French" },
  { code: "frm", name: "Middle French" },
  { code: "fro", name: "Old French" },
  { code: "frr", name: "Northern Frisian" },
  { code: "frs", name: "Eastern Frisian" },
  { code: "fry", name: "Western Frisian" },
  { code: "ful", name: "Fulah" },
  { code: "fur", name: "Friulian" },
  { code: "gaa", name: "Ga" },
  { code: "gay", name: "Gayo" },
  { code: "gba", name: "Gbaya" },
  { code: "geo", name: "Georgian" },
  { code: "ger", name: "German" },
  { code: "gez", name: "Geez" },
  { code: "gil", name: "Gilbertese" },
  { code: "gla", name: "Scottish Gaelic" },
  { code: "gle", name: "Irish" },
  { code: "glg", name: "Galician" },
  { code: "glv", name: "Manx" },
  { code: "gmh", name: "Middle High German" },
  { code: "goh", name: "Old High German" },
  { code: "gon", name: "Gondi" },
  { code: "gor", name: "Gorontalo" },
  { code: "got", name: "Gothic" },
  { code: "grb", name: "Grebo" },
  { code: "grc", name: "Ancient Greek" },
  { code: "gre", name: "Greek" },
  { code: "grn", name: "Guarani" },
  { code: "gsw", name: "Swiss German" },
  { code: "guj", name: "Gujarati" },
  { code: "gwi", name: "Gwich'in" },
  { code: "hai", name: "Haida" },
  { code: "hat", name: "Haitian" },
  { code: "hau", name: "Hausa" },
  { code: "haw", name: "Hawaiian" },
  { code: "heb", name: "Hebrew" },
  { code: "her", name: "Herero" },
  { code: "hil", name: "Hiligaynon" },
  { code: "hin", name: "Hindi" },
  { code: "hit", name: "Hittite" },
  { code: "hmn", name: "Hmong" },
  { code: "hmo", name: "Hiri Motu" },
  { code: "hrv", name: "Croatian" },
  { code: "hsb", name: "Upper Sorbian" },
  { code: "hun", name: "Hungarian" },
  { code: "hup", name: "Hupa" },
  { code: "hye", name: "Armenian" },
  { code: "ibo", name: "Igbo" },
  { code: "ice", name: "Icelandic" },
  { code: "ido", name: "Ido" },
  { code: "iii", name: "Sichuan Yi" },
  { code: "iku", name: "Inuktitut" },
  { code: "ile", name: "Interlingue" },
  { code: "ilo", name: "Iloko" },
  { code: "ina", name: "Interlingua" },
  { code: "ind", name: "Indonesian" },
  { code: "inh", name: "Ingush" },
  { code: "ipk", name: "Inupiaq" },
  { code: "isl", name: "Icelandic" },
  { code: "ita", name: "Italian" },
  { code: "jav", name: "Javanese" },
  { code: "jbo", name: "Lojban" },
  { code: "jpn", name: "Japanese" },
  { code: "jpr", name: "Judeo-Persian" },
  { code: "jrb", name: "Judeo-Arabic" },
  { code: "kaa", name: "Kara-Kalpak" },
  { code: "kab", name: "Kabyle" },
  { code: "kac", name: "Kachin" },
  { code: "kal", name: "Kalaallisut" },
  { code: "kam", name: "Kamba" },
  { code: "kan", name: "Kannada" },
  { code: "kas", name: "Kashmiri" },
  { code: "kat", name: "Georgian" },
  { code: "kau", name: "Kanuri" },
  { code: "kaw", name: "Kawi" },
  { code: "kaz", name: "Kazakh" },
  { code: "kbd", name: "Kabardian" },
  { code: "kha", name: "Khasi" },
  { code: "khm", name: "Central Khmer" },
  { code: "kho", name: "Khotanese" },
  { code: "kik", name: "Kikuyu" },
  { code: "kin", name: "Kinyarwanda" },
  { code: "kir", name: "Kirghiz" },
  { code: "kmb", name: "Kimbundu" },
  { code: "kok", name: "Konkani" },
  { code: "kom", name: "Komi" },
  { code: "kon", name: "Kongo" },
  { code: "kor", name: "Korean" },
  { code: "kos", name: "Kosraean" },
  { code: "kpe", name: "Kpelle" },
  { code: "krc", name: "Karachay-Balkar" },
  { code: "krl", name: "Karelian" },
  { code: "kru", name: "Kurukh" },
  { code: "kua", name: "Kuanyama" },
  { code: "kum", name: "Kumyk" },
  { code: "kur", name: "Kurdish" },
  { code: "kut", name: "Kutenai" },
  { code: "lad", name: "Ladino" },
  { code: "lah", name: "Lahnda" },
  { code: "lam", name: "Lamba" },
  { code: "lao", name: "Lao" },
  { code: "lat", name: "Latin" },
  { code: "lav", name: "Latvian" },
  { code: "lez", name: "Lezghian" },
  { code: "lim", name: "Limburgan" },
  { code: "lin", name: "Lingala" },
  { code: "lit", name: "Lithuanian" },
  { code: "lol", name: "Mongo" },
  { code: "loz", name: "Lozi" },
  { code: "ltz", name: "Luxembourgish" },
  { code: "lua", name: "Luba-Lulua" },
  { code: "lub", name: "Luba-Katanga" },
  { code: "lug", name: "Ganda" },
  { code: "lui", name: "Luiseno" },
  { code: "lun", name: "Lunda" },
  { code: "luo", name: "Luo (Kenya and Tanzania)" },
  { code: "lus", name: "Lushai" },
  { code: "mac", name: "Macedonian" },
  { code: "mad", name: "Madurese" },
  { code: "mag", name: "Magahi" },
  { code: "mah", name: "Marshallese" },
  { code: "mai", name: "Maithili" },
  { code: "mak", name: "Makasar" },
  { code: "mal", name: "Malayalam" },
  { code: "man", name: "Mandingo" },
  { code: "mao", name: "Maori" },
  { code: "mar", name: "Marathi" },
  { code: "mas", name: "Masai" },
  { code: "may", name: "Malay" },
  { code: "mdf", name: "Moksha" },
  { code: "mdr", name: "Mandar" },
  { code: "men", name: "Mende" },
  { code: "mga", name: "Middle Irish" },
  { code: "mic", name: "Mi'kmaq" },
  { code: "min", name: "Minangkabau" },
  { code: "mkd", name: "Macedonian" },
  { code: "mlg", name: "Malagasy" },
  { code: "mlt", name: "Maltese" },
  { code: "mnc", name: "Manchu" },
  { code: "mni", name: "Manipuri" },
  { code: "moh", name: "Mohawk" },
  { code: "mon", name: "Mongolian" },
  { code: "mos", name: "Mossi" },
  { code: "mri", name: "Maori" },
  { code: "msa", name: "Malay" },
  { code: "mwl", name: "Mirandese" },
  { code: "mwr", name: "Marwari" },
  { code: "mya", name: "Burmese" },
  { code: "myv", name: "Erzya" },
  { code: "nap", name: "Neapolitan" },
  { code: "nau", name: "Nauru" },
  { code: "nav", name: "Navajo" },
  { code: "nbl", name: "South Ndebele" },
  { code: "nde", name: "North Ndebele" },
  { code: "ndo", name: "Ndonga" },
  { code: "nds", name: "Low German" },
  { code: "nep", name: "Nepali" },
  { code: "new", name: "Nepal Bhasa" },
  { code: "nia", name: "Nias" },
  { code: "niu", name: "Niuean" },
  { code: "nld", name: "Dutch" },
  { code: "nno", name: "Norwegian Nynorsk" },
  { code: "nob", name: "Norwegian Bokmål" },
  { code: "nog", name: "Nogai" },
  { code: "non", name: "Old Norse" },
  { code: "nor", name: "Norwegian" },
  { code: "nqo", name: "N'Ko" },
  { code: "nso", name: "Pedi" },
  { code: "nya", name: "Chichewa" },
  { code: "nym", name: "Nyamwezi" },
  { code: "nyn", name: "Nyankole" },
  { code: "nyo", name: "Nyoro" },
  { code: "nzi", name: "Nzima" },
  { code: "oci", name: "Occitan" },
  { code: "oji", name: "Ojibwa" },
  { code: "ori", name: "Oriya" },
  { code: "orm", name: "Oromo" },
  { code: "osa", name: "Osage" },
  { code: "oss", name: "Ossetian" },
  { code: "ota", name: "Ottoman Turkish" },
  { code: "pag", name: "Pangasinan" },
  { code: "pal", name: "Pahlavi" },
  { code: "pam", name: "Pampanga" },
  { code: "pan", name: "Panjabi" },
  { code: "pap", name: "Papiamento" },
  { code: "pau", name: "Palauan" },
  { code: "peo", name: "Old Persian" },
  { code: "per", name: "Persian" },
  { code: "phn", name: "Phoenician" },
  { code: "pli", name: "Pali" },
  { code: "pol", name: "Polish" },
  { code: "pon", name: "Pohnpeian" },
  { code: "por", name: "Portuguese" },
  { code: "pro", name: "Old Provençal" },
  { code: "pus", name: "Pushto" },
  { code: "que", name: "Quechua" },
  { code: "raj", name: "Rajasthani" },
  { code: "rap", name: "Rapanui" },
  { code: "rar", name: "Rarotongan" },
  { code: "roh", name: "Romansh" },
  { code: "rom", name: "Romany" },
  { code: "ron", name: "Romanian" },
  { code: "rum", name: "Romanian" },
  { code: "run", name: "Rundi" },
  { code: "rup", name: "Aromanian" },
  { code: "rus", name: "Russian" },
  { code: "sad", name: "Sandawe" },
  { code: "sag", name: "Sango" },
  { code: "sah", name: "Yakut" },
  { code: "sam", name: "Samaritan Aramaic" },
  { code: "san", name: "Sanskrit" },
  { code: "sas", name: "Sasak" },
  { code: "sat", name: "Santali" },
  { code: "scn", name: "Sicilian" },
  { code: "sco", name: "Scots" },
  { code: "sel", name: "Selkup" },
  { code: "sga", name: "Old Irish" },
  { code: "shn", name: "Shan" },
  { code: "sid", name: "Sidamo" },
  { code: "sin", name: "Sinhala" },
  { code: "slk", name: "Slovak" },
  { code: "slo", name: "Slovak" },
  { code: "slv", name: "Slovenian" },
  { code: "sma", name: "Southern Sami" },
  { code: "sme", name: "Northern Sami" },
  { code: "smj", name: "Lule Sami" },
  { code: "smn", name: "Inari Sami" },
  { code: "smo", name: "Samoan" },
  { code: "sms", name: "Skolt Sami" },
  { code: "sna", name: "Shona" },
  { code: "snd", name: "Sindhi" },
  { code: "snk", name: "Soninke" },
  { code: "sog", name: "Sogdian" },
  { code: "som", name: "Somali" },
  { code: "sot", name: "Southern Sotho" },
  { code: "spa", name: "Spanish" },
  { code: "sqi", name: "Albanian" },
  { code: "srd", name: "Sardinian" },
  { code: "srn", name: "Sranan Tongo" },
  { code: "srp", name: "Serbian" },
  { code: "srr", name: "Serer" },
  { code: "ssw", name: "Swati" },
  { code: "suk", name: "Sukuma" },
  { code: "sun", name: "Sundanese" },
  { code: "sus", name: "Susu" },
  { code: "sux", name: "Sumerian" },
  { code: "swa", name: "Swahili" },
  { code: "swe", name: "Swedish" },
  { code: "syc", name: "Classical Syriac" },
  { code: "syr", name: "Syriac" },
  { code: "tah", name: "Tahitian" },
  { code: "tam", name: "Tamil" },
  { code: "tat", name: "Tatar" },
  { code: "tel", name: "Telugu" },
  { code: "tem", name: "Timne" },
  { code: "ter", name: "Tereno" },
  { code: "tet", name: "Tetum" },
  { code: "tgk", name: "Tajik" },
  { code: "tgl", name: "Tagalog" },
  { code: "tha", name: "Thai" },
  { code: "tib", name: "Tibetan" },
  { code: "tig", name: "Tigre" },
  { code: "tir", name: "Tigrinya" },
  { code: "tiv", name: "Tiv" },
  { code: "tkl", name: "Tokelau" },
  { code: "tlh", name: "Klingon" },
  { code: "tli", name: "Tlingit" },
  { code: "tmh", name: "Tamashek" },
  { code: "tog", name: "Nyasa Tonga" },
  { code: "ton", name: "Tongan" },
  { code: "tpi", name: "Tok Pisin" },
  { code: "tsi", name: "Tsimshian" },
  { code: "tsn", name: "Tswana" },
  { code: "tso", name: "Tsonga" },
  { code: "tuk", name: "Turkmen" },
  { code: "tum", name: "Tumbuka" },
  { code: "tur", name: "Turkish" },
  { code: "tvl", name: "Tuvalu" },
  { code: "twi", name: "Twi" },
  { code: "tyv", name: "Tuvinian" },
  { code: "udm", name: "Udmurt" },
  { code: "uga", name: "Ugaritic" },
  { code: "uig", name: "Uighur" },
  { code: "ukr", name: "Ukrainian" },
  { code: "umb", name: "Umbundu" },
  { code: "urd", name: "Urdu" },
  { code: "uzb", name: "Uzbek" },
  { code: "vai", name: "Vai" },
  { code: "ven", name: "Venda" },
  { code: "vie", name: "Vietnamese" },
  { code: "vol", name: "Volapük" },
  { code: "vot", name: "Votic" },
  { code: "wal", name: "Wolaitta" },
  { code: "war", name: "Waray" },
  { code: "was", name: "Washo" },
  { code: "wel", name: "Welsh" },
  { code: "wln", name: "Walloon" },
  { code: "wol", name: "Wolof" },
  { code: "xal", name: "Kalmyk" },
  { code: "xho", name: "Xhosa" },
  { code: "yao", name: "Yao" },
  { code: "yap", name: "Yapese" },
  { code: "yid", name: "Yiddish" },
  { code: "yor", name: "Yoruba" },
  { code: "zap", name: "Zapotec" },
  { code: "zen", name: "Zenaga" },
  { code: "zgh", name: "Standard Moroccan Tamazight" },
  { code: "zha", name: "Zhuang" },
  { code: "zho", name: "Chinese" },
  { code: "zul", name: "Zulu" },
  { code: "zun", name: "Zuni" },
  { code: "zza", name: "Zaza" },
];

/**
 * ISO 639-2's ~20 bibliographic(B)/terminologic(T) code pairs: two distinct
 * 3-letter codes for the SAME language (e.g. "ger"/"deu" both mean German).
 * `[bCode, tCode]` order throughout. languageMatches() (below) is what
 * makes a stored preference in one code match a stream tagged with the
 * other.
 */
export const LANGUAGE_EQUIVALENCE_PAIRS: readonly (readonly [string, string])[] = [
  ["alb", "sqi"], // Albanian
  ["arm", "hye"], // Armenian
  ["baq", "eus"], // Basque
  ["bur", "mya"], // Burmese
  ["chi", "zho"], // Chinese
  ["cze", "ces"], // Czech
  ["dut", "nld"], // Dutch
  ["fre", "fra"], // French
  ["geo", "kat"], // Georgian
  ["ger", "deu"], // German
  ["gre", "ell"], // Greek
  ["ice", "isl"], // Icelandic
  ["mac", "mkd"], // Macedonian
  ["mao", "mri"], // Maori
  ["may", "msa"], // Malay
  ["per", "fas"], // Persian
  ["rum", "ron"], // Romanian
  ["slo", "slk"], // Slovak
  ["tib", "bod"], // Tibetan
  ["wel", "cym"], // Welsh
];

const KNOWN_LANGUAGE_CODE_SET: ReadonlySet<string> = new Set(LANGUAGE_CODES.map((l) => l.code));

/** True iff `code` is a member of LANGUAGE_CODES — the server-side
 *  membership check for UserSettings.audioPreferredLanguage /
 *  subtitlePreferredLanguage (the contract's `pattern` only checks shape,
 *  three lowercase letters; this checks it names a REAL language). */
export function isKnownLanguageCode(code: string): boolean {
  return KNOWN_LANGUAGE_CODE_SET.has(code);
}

const EQUIVALENT_CODE: ReadonlyMap<string, string> = new Map(
  LANGUAGE_EQUIVALENCE_PAIRS.flatMap(([b, t]) => [
    [b, t],
    [t, b],
  ] as const),
);

/**
 * True iff `a` and `b` name the same language: identical codes, or one of
 * ISO 639-2's B/T pairs (e.g. "fra" languageMatches "fre"). `null`/
 * `undefined`/empty-string never match anything, INCLUDING each other —
 * "no preference" is not "this pref matches every stream", it is "fall
 * through to the next rule in the cascade" (docs/PLAYBACK.md §2.6), and
 * that fallthrough is the CALLER's job (apps/server/src/playback/
 * resolve-selection.ts), not this function's.
 */
export function languageMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return EQUIVALENT_CODE.get(a) === b;
}
