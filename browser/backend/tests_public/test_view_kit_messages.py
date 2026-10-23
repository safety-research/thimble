"""The view kit's messages on the server's side (backend/app/viewer_messages.js thimble.messages): every view page loads
the part after the transcript, whose look its header, date lines and Show more share, and before the search; its styles
come with the kit's (viewer_parts.css); and a page lays the messages out but does not restyle them (views.own_parts).
How it draws is frontend/tests/public/data-kit.test.ts and browser/kit-messages.test.ts."""
from __future__ import annotations

from app import views


def test_a_page_lays_out_the_messages_but_does_not_restyle_them():
    css = ("<style>#thread .thimble-msg-list { flex: 1 } .thimble-msg { margin: 0 8px } .thimble-msg-author { color: red }"
           " .thimble-msg.is-reply { border-left: 2px solid #d0750a } .thimble-msg-dots { border-radius: 999px }</style>")
    assert views.own_parts(css) == [
        "`.thimble-msg-author` sets color",
        "`.thimble-msg.is-reply` sets border-left",
        "`.thimble-msg-dots` sets border-radius",
    ]
