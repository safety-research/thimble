// A session of thimble-cc-mod on the collusion-wiki corpus as the home panel reads it (register.tsx homeData): two
// views, a report, two side threads, nine cards from six questions, a label tried on a sample, four files. Taken from
// a live session's .thimble-cc-mod; `groups` name their cards by id, `cards` hold each card's kind and question.
import type { HomeCard, HomeData } from '../hooks/home'

type Group = Omit<HomeData['cardGroups'][number], 'cards'> & { cards: string[] }

export const SESSION: Omit<HomeData, 'cardGroups'> & { groups: Group[]; cards: (HomeCard & { created: number })[] } = {
 "views": [
  {
   "slug": "usernames-over-time",
   "name": "Usernames Over Time",
   "state": "proposed",
   "words": "proposed",
   "files": [
    "labels.jsonl",
    "revisions.jsonl"
   ],
   "unit": "one lane per username, keyed by label in labels.jsonl (3,104 usernames, including the blank username for unsigned saves and the administrator Friedrich1982 with no revisions); each mark in a lane is one revision from revisions.jsonl, joined on its label field and placed at its time (14,591 revisions, 2026-05-24 to 2026-07-02)",
   "drawable": false,
   "left": 0,
   "at": 1791237000000
  },
  {
   "slug": "wiki-pages",
   "name": "Wiki Pages",
   "state": "built",
   "words": "built · 1 problem left, 7 fixed",
   "files": [
    "pages.jsonl"
   ],
   "unit": "one row per page, keyed by page_id (wiki/name); 4,579 pages: dse 3,908, probier 601, fractal 68, dorfwiki 2",
   "drawable": true,
   "left": 1,
   "at": 1791237615290
  }
 ],
 "reports": [
  {
   "slug": "what-the-agents-did-to-the-wikis",
   "title": "Agents filled the dse wiki with pages of links, and its maintainer deleted nearly all of them",
   "form": "document",
   "state": "ready",
   "cards": 5,
   "tools": 9,
   "at": 1791237119983
  }
 ],
 "threads": [
  {
   "id": "tmuvs6x2q1",
   "title": "\"Is AgentRelent one agent or several? Look at the IPs and times of its revisions.\"",
   "about": "about the last answer",
   "words": "answered · 1 question",
   "tone": "ok",
   "unread": 1,
   "earlier": false,
   "at": 1791236929931
  },
  {
   "id": "tmuvs77ce2",
   "title": "\"Which pages existed before the agents arrived, and what did the agents do to StartSeite?\"",
   "about": "about the last answer",
   "words": "answered · 1 question",
   "tone": "ok",
   "unread": 0,
   "earlier": false,
   "at": 1791236917652
  }
 ],
 "groups": [
  {
   "head": "Agents filled the dse wiki with pages of links, and its maintainer deleted nearly all of them",
   "from": "report",
   "cards": [
    "10b4a0",
    "f3c287",
    "f8036a",
    "00ed45",
    "6f2b98"
   ],
   "at": 1791237119983
  },
  {
   "head": "\"Is AgentRelent one agent or several? Look at the IPs and times of its revisions.\"",
   "from": "thread",
   "cards": [
    "f8036a"
   ],
   "at": 1791236929931
  },
  {
   "head": "\"Which pages existed before the agents arrived, and what did the agents do to StartSeite?\"",
   "from": "thread",
   "cards": [
    "f3c287"
   ],
   "at": 1791236917652
  },
  {
   "head": "Which wikis did the agents write to, and how many revisions and pages on each?",
   "from": "answer",
   "cards": [
    "10b4a0"
   ],
   "at": 1791236850000
  },
  {
   "head": "When did the writing happen? Show revisions per day by wiki, and which usernames wrote the most on dse.",
   "from": "answer",
   "cards": [
    "0df912",
    "5d02e7"
   ],
   "at": 1791236877000
  },
  {
   "head": "Use the label tool: a prompt label named 'page kind' over pages.jsonl with values test page, links or data, prose, tried on 60 pages.",
   "from": "answer",
   "cards": [
    "e86e51",
    "d0f758"
   ],
   "at": 1791236987000
  }
 ],
 "cards": [
  {
   "id": "00ed45",
   "kind": "line",
   "question": "How many agent revisions and maintainer deletions were there each day on dse?",
   "created": 1791237160000
  },
  {
   "id": "0df912",
   "kind": "line",
   "question": "How many agent revisions were saved each day, by wiki?",
   "created": 1791236869000
  },
  {
   "id": "10b4a0",
   "kind": "table",
   "question": "Which wikis did the agents write to, and how many revisions and pages on each?",
   "created": 1791236837000
  },
  {
   "id": "5d02e7",
   "kind": "bar",
   "question": "Which usernames saved the most agent revisions on dse?",
   "created": 1791236869000
  },
  {
   "id": "6f2b98",
   "kind": "table",
   "question": "What did the maintainer MartinHuber do on dse?",
   "created": 1791237160000
  },
  {
   "id": "d0f758",
   "kind": "example",
   "question": "What do records of each value of \"page kind\" look like? (trial)",
   "created": 1791236983000
  },
  {
   "id": "e86e51",
   "kind": "bar",
   "question": "How many of 60 sampled records get each value of \"page kind\"?",
   "created": 1791236983000
  },
  {
   "id": "f3c287",
   "kind": "table",
   "question": "Which pages existed before the agents arrived, and how much did agents edit them?",
   "created": 1791236906000
  },
  {
   "id": "f8036a",
   "kind": "line",
   "question": "Which numbered link did each AgentRelent save add, over time on 18 June?",
   "created": 1791236919000
  }
 ],
 "labels": [
  {
   "slug": "page-kind",
   "name": "page kind",
   "kind": "prompt",
   "trial": true,
   "counts": {
    "test page": 29,
    "links or data": 20,
    "prose": 11
   },
   "values": [
    "test page",
    "links or data",
    "prose"
   ],
   "paths": [
    "pages.jsonl"
   ],
   "running": false
  }
 ],
 "files": [
  {
   "file": "revisions.jsonl",
   "records": 14591,
   "size": 33478335,
   "seen": 5,
   "state": "read",
   "ranges": [
    [
     1,
     2
    ],
    [
     13611,
     13611
    ],
    [
     14005,
     14006
    ]
   ]
  },
  {
   "file": "events.jsonl",
   "records": 19931,
   "size": 5381614,
   "seen": 2,
   "state": "read",
   "ranges": [
    [
     1,
     2
    ]
   ]
  },
  {
   "file": "pages.jsonl",
   "records": 4579,
   "size": 1662919,
   "seen": 13,
   "state": "read",
   "ranges": [
    [
     1,
     2
    ],
    [
     79,
     79
    ],
    [
     855,
     855
    ]
   ]
  },
  {
   "file": "labels.jsonl",
   "records": 3104,
   "size": 1065401,
   "seen": 0,
   "state": "scanned",
   "ranges": []
  }
 ],
 "coverage": "read 4 of 4 files · <0.1% of records · 0.1% judged by a label"
}
