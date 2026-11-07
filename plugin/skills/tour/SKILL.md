---
name: tour
description: A two-minute tour of thimble on made-up sample data, in this conversation. Start it when the person asks for a tour of thimble. The person starts it with /thimble:tour.
---

You give the person a short tour of thimble. Say each step's words exactly as written below, one step per message, and nothing else: no greeting, no summary, no comment on thimble's reports. Call no tool to say a step.

The sample data is ${CLAUDE_PLUGIN_ROOT}/tour/sample/orders.csv: one row per order of Fernhill Tea, a made-up online tea shop, in March 2026. Step 0 is a fixed answer about it. One number in that answer is wrong on purpose, so that the person sees thimble check it. These two rules are for your own messages only: do not read the file to write step 0, and do not correct the wrong number in your messages. thimble's checker reads the file, checks each cited number, and corrects the wrong one.

thimble sees what the person does. When a step is done, a prompt from thimble that starts with "(thimble tour)" names the step to say next. Say that step at once. When the person writes something else, answer in one or two short sentences, then say the step you said last again.

## Step 0

Say it now. Your message is the text between the two lines of dashes, word for word, without the dashes.

----------
**Fernhill Tea's orders in March 2026** (`orders.csv`)

Customers of Fernhill Tea, a small online tea shop, placed [36 orders](#) in March 2026, worth [$1,872](#) in all. That is an average order value of [$52](#).

The North region placed the most orders, [14 of the 36](#). The South came second, and the East and the West placed fewer. Loose-leaf tins were most of the orders. Gift boxes and samplers made up the rest.

Two carriers shipped the orders. Parcelo shipped most of them, and Swiftbox shipped the rest. [6 orders](#) arrived late, and most of the late ones went by Parcelo.

The shop refunded [7 orders](#). Most of the refunded orders arrived on time, so late delivery does not explain the refunds.
----------

## Step 1

Select the words “average order value” in the Fernhill Tea answer with the mouse, then press e.

## Step 2

One number in the Fernhill Tea answer was wrong on purpose. Click the number of refunded orders to see thimble's check of it.

## Step 2k

One number in the Fernhill Tea answer was wrong on purpose. Press ] until the tray above the prompt shows the number of refunded orders and its check.

## Step 3

Press v to draw a card of the Fernhill Tea answer.

## Step 4

Press s for a shorter, plainer version of the Fernhill Tea answer.

## Step 5

The tour is over. For thimble's settings, click thimble on the bar or type /thimble-settings.

## Step 5k

The tour is over. For thimble's settings, type /thimble-settings.
