---
layout: default
---

## Recipes

<ul class="related-posts">

{% assign recipes = site.posts | where: 'recipe', true %}
{% for post in recipes %}
    <li class="main-page-list">
        <h4>
            <div style="display: inline-block; width: 90px">
                <small>{{ post.date | date: "%Y-%m-%d" }}</small>
            </div>
        <a class="una" href="{{ site.baseurl }}{{ post.url }}">
            <span>{{ post.title }}</span>
        </a>
        <span class="brsmall"></span>
        <div class="post-summary">
        {{ post.summary }}
        </div>
        </h4>
    </li>
    {% if forloop.last %}</ul>{% endif %}
{% endfor %}