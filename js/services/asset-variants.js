import { HEROES } from '../game/heroes.js';

function stem(hero) {
  return hero.portrait.split('/').pop().replace(/\.[^.]+$/, '');
}

export const H5_HERO_VARIANTS = Object.freeze(Object.fromEntries(HEROES.map((hero) => [
  hero.id,
  Object.freeze({
    thumb: `assets/h5/heroes/${stem(hero)}_320.webp`,
    detail: `assets/h5/heroes/${stem(hero)}_640.webp`,
  }),
])));

export const H5_HERO_PATHS = Object.freeze(
  Object.values(H5_HERO_VARIANTS).flatMap((variant) => [variant.thumb, variant.detail]),
);

export const H5_BACKGROUND = 'assets/h5/backgrounds/gaming_bg_1280.webp';
export const H5_SEAT_FRAME = 'assets/theme/seat_frame.png';
export const H5_CARD_BACK = 'assets/h5/cards/cardback.webp';
export const H5_CARD_FACES = Object.freeze({
  2: 'assets/h5/cards/rank_02.webp',
  3: 'assets/h5/cards/rank_03.webp',
  4: 'assets/h5/cards/rank_04.webp',
  5: 'assets/h5/cards/rank_05.webp',
  6: 'assets/h5/cards/rank_06.webp',
  7: 'assets/h5/cards/rank_07.webp',
  8: 'assets/h5/cards/rank_08.webp',
  9: 'assets/h5/cards/rank_09.webp',
  10: 'assets/h5/cards/rank_10.webp',
  11: 'assets/h5/cards/rank_J.webp',
  12: 'assets/h5/cards/rank_Q.webp',
  13: 'assets/h5/cards/rank_K.webp',
  14: 'assets/h5/cards/rank_A.webp',
});
export const H5_CARD_PATHS = Object.freeze([H5_CARD_BACK, ...Object.values(H5_CARD_FACES)]);
export const H5_STATIC_PATHS = Object.freeze([
  H5_BACKGROUND,
  H5_SEAT_FRAME,
  ...H5_HERO_PATHS,
  ...H5_CARD_PATHS,
]);

export function h5HeroPortrait(hero, size = 'thumb') {
  return H5_HERO_VARIANTS[hero?.id]?.[size] || hero?.portrait || '';
}
