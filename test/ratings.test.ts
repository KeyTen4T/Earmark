import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearMatch, cleanBookTitle, findClearMatch, formatAverage, formatRatings, parseOlDocs,
  parseReviews, pickBestRating, plainText, ratingAccessibilityLabel,
} from '../src/ratings-match';

test('ratings: cleaning an Apple catalogue title strips subtitles and series notes', () => {
  assert.equal(cleanBookTitle('Dune'), 'Dune');
  assert.equal(cleanBookTitle('Dune (Unabridged)'), 'Dune');
  assert.equal(cleanBookTitle('Dune Messiah: Book 2 of the Dune Chronicles'), 'Dune Messiah');
  assert.equal(cleanBookTitle('The Expanse, Book 1'), 'The Expanse');
  assert.equal(cleanBookTitle('Leviathan Wakes (The Expanse 1)'), 'Leviathan Wakes');
  assert.equal(cleanBookTitle('Project Hail Mary: A Novel'), 'Project Hail Mary');
  assert.equal(cleanBookTitle('Mistborn - The Final Empire'), 'Mistborn');
});

test('ratings: the clear-match rule accepts the same title and author', () => {
  const dune = { title: 'Dune', author: 'Frank Herbert' };
  assert.ok(clearMatch(dune, { title: 'Dune', author: 'Frank Herbert' }));
  // The candidate's series note is cleaned first, so it still matches.
  assert.ok(clearMatch({ title: 'Leviathan Wakes', author: 'James S. A. Corey' },
    { title: 'Leviathan Wakes (The Expanse 1)', author: 'James S. A. Corey' }));
});

test('ratings: the clear-match rule rejects another book by the same author', () => {
  assert.equal(clearMatch({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune Messiah', author: 'Frank Herbert' }), false);
});

test('ratings: the clear-match rule rejects a different author', () => {
  assert.equal(clearMatch({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune', author: 'Kevin J. Anderson' }), false);
});

test('ratings: the clear-match rule rejects a missing author on either side', () => {
  assert.equal(clearMatch({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune' }), false);
  assert.equal(clearMatch({ title: 'Dune', author: '' }, { title: 'Dune', author: 'Frank Herbert' }), false);
});

test('ratings: picks the most-rated clear match and ignores the rest', () => {
  const book = { title: 'Dune', author: 'Frank Herbert' };
  const chosen = pickBestRating(book, [
    { key: '/works/OL1W', title: 'Dune', author: 'Frank Herbert', ratingsAverage: 3.9, ratingsCount: 12 },
    { key: '/works/OL2W', title: 'Dune', author: 'Kevin J. Anderson', ratingsAverage: 5, ratingsCount: 9000 },
    { key: '/works/OL3W', title: 'Dune', author: 'Frank Herbert', ratingsAverage: 4.3, ratingsCount: 448 },
  ]);
  assert.equal(chosen?.key, '/works/OL3W');
  assert.equal(chosen?.ratingsCount, 448);
});

test('ratings: nothing is chosen below the minimum count', () => {
  const book = { title: 'Dune', author: 'Frank Herbert' };
  assert.equal(pickBestRating(book, [{ key: '/works/OL1W', title: 'Dune', author: 'Frank Herbert', ratingsAverage: 5, ratingsCount: 2 }]), undefined);
  assert.equal(findClearMatch(book, []), undefined);
});

test('ratings: parsing Open Library docs tolerates missing fields', () => {
  const docs = parseOlDocs({ docs: [
    { key: '/works/OL1W', title: 'Dune', author_name: ['Frank Herbert'], ratings_average: 4.3, ratings_count: 448 },
    { title: 'No Key', author_name: 'not-an-array' },
    null,
    { key: '/works/OL2W' },
  ] });
  assert.deepEqual(docs[0], { key: '/works/OL1W', title: 'Dune', author: 'Frank Herbert', ratingsAverage: 4.3, ratingsCount: 448 });
  assert.deepEqual(docs[1], { key: undefined, title: 'No Key', author: undefined, ratingsAverage: undefined, ratingsCount: undefined });
  assert.equal(docs.length, 2);
});

test('ratings: count and average formatting', () => {
  assert.equal(formatRatings(1), '1 rating');
  assert.equal(formatRatings(448), '448 ratings');
  assert.equal(formatRatings(1000), '1k ratings');
  assert.equal(formatRatings(12400), '12.4k ratings');
  assert.equal(formatAverage(4.3), '4.3');
  assert.equal(formatAverage(4), '4.0');
  assert.equal(ratingAccessibilityLabel(4.3, 448, 'Open Library'), 'Rated 4.3 out of 5 from 448 ratings on Open Library');
});

test('ratings: reviews are filtered, sorted by likes and clamped to five', () => {
  const row = (username: string, likes: number, text: string) => ({ user: { username }, likes_count: likes, review: text });
  const rows = [
    row('a', 1, 'A'), row('b', 50, 'B'), row('c', 3, 'C'),
    { user: { username: 'spoiler' }, likes_count: 99, review: 'Secret', review_has_spoilers: true },
    { user: { username: 'empty' }, likes_count: 60, review: '   ' },
    row('d', 7, 'D'), row('e', 2, 'E'), row('f', 9, 'F'),
  ];
  const reviews = parseReviews({ user_books: rows });
  assert.equal(reviews.length, 5);
  assert.deepEqual(reviews.map((r) => r.username), ['b', 'f', 'd', 'c', 'e']);
});

test('ratings: review markup is stripped to plain text', () => {
  assert.equal(plainText('<p>Hello <b>world</b><br>Next</p>'), 'Hello world\nNext');
  assert.equal(plainText('[link](https://example.com) and **bold** and _italic_'), 'link and bold and italic');
  assert.equal(plainText('A &amp; B &lt;tag&gt;'), 'A & B <tag>');
  assert.deepEqual(
    parseReviews({ user_books: [{ user: { username: 'reader' }, review_markdown: '## Great\n\n> Wow **yes**', rating: '4.5', likes_count: 3 }] }),
    [{ username: 'reader', rating: 4.5, text: 'Great\n\nWow yes', likes: 3 }],
  );
  // review_raw is the fallback when review is absent.
  assert.equal(parseReviews({ user_books: [{ user: { username: 'r' }, review_raw: 'From raw', likes_count: 0 }] })[0].text, 'From raw');
});

test('ratings: malformed review rows are dropped rather than guessed at', () => {
  assert.deepEqual(parseReviews(null), []);
  assert.deepEqual(parseReviews({}), []);
  assert.deepEqual(parseReviews({ user_books: 'nope' }), []);
  assert.deepEqual(parseReviews({ user_books: [
    null, 42, {}, { user: {} }, { user: { username: 'noText' }, likes_count: 4 },
  ] }), []);
});
