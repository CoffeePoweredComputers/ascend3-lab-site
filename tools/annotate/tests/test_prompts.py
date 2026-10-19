"""Each card shows, folded, the prompt its submission answered."""

from conftest import LEAD
from helpers import tokens, track_id

from annotate import stages, studies

PROJECTS = ("text_stats", "grade_report", "price_summary", "fitness_tracker", "sales_analysis",
            "weather_report", "gradebook", "pet_shelter", "playlist_manager")


def test_every_decomp_project_has_a_prompt():
    for project in PROJECTS:
        assert stages.prompt("decomp", project).startswith("### Problem Decomposition"), project


def test_only_plain_project_names_are_looked_up():
    assert stages.prompt("decomp", "../01-clean-and-read") == ""
    assert stages.prompt("decomp", "no_such_project") == ""
    assert stages.prompt("ethics", "text_stats") == ""


def test_a_card_is_headed_by_its_prompt(client):
    track = track_id()
    html = client.get(f"/t/{track}/items/{tokens(track, 'cleared', drawn=True)[0]}", headers=LEAD).text
    assert '<section class="prompt"' in html
    # The problem itself is shown; the examples wait in a fold.
    assert "Problem Decomposition" in html and "Full prompt" in html
    assert html.index('class="prompt"') < html.index('class="item-image"')


def test_the_diagram_opens_big(client):
    track = track_id()
    html = client.get(f"/t/{track}/items/{tokens(track, 'cleared', drawn=True)[0]}", headers=LEAD).text
    assert 'class="zoom" data-zoom data-key="+"' in html


def test_a_photo_being_cleaned_has_no_prompt(client):
    track = track_id()
    html = client.get(f"/t/{track}/triage/{tokens(track, 'untriaged')[0]}", headers=LEAD).text
    assert '<section class="prompt"' not in html


def test_a_study_without_prompts_shows_none(client):
    track = track_id("ethics-demo")
    html = client.get(f"/t/{track}/items/{tokens(track, 'cleared')[0]}", headers=LEAD).text
    assert 'class="prompt"' not in html and "prompt-fold" not in html
    assert studies.get("ethics").kind == "ethics"
