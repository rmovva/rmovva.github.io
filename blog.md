---
layout: default
---

## Blog

<ul class="related-posts">

{% assign blog_posts = site.posts | where: 'blog_post', true %}
{% for post in blog_posts %}
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

## Recipes

I've started using [Substack](https://rajmovva.substack.com/) for food writing instead, so this page may no longer receive updates.

<ul class="related-posts">

{% assign blog_posts = site.posts | where: 'recipe', true %}
{% for post in blog_posts %}
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