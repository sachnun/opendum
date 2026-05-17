<script setup lang="ts">
import type { DateRange, DateValue } from "reka-ui";
import {
  RangeCalendarCell,
  RangeCalendarCellTrigger,
  RangeCalendarGrid,
  RangeCalendarGridBody,
  RangeCalendarGridHead,
  RangeCalendarGridRow,
  RangeCalendarHeadCell,
  RangeCalendarHeader,
  RangeCalendarHeading,
  RangeCalendarNext,
  RangeCalendarPrev,
  RangeCalendarRoot,
} from "reka-ui";
import { cn } from "../../lib/utils";

const props = withDefaults(
  defineProps<{
    class?: string;
    isDateDisabled?: (date: DateValue) => boolean;
  }>(),
  {
    class: "",
    isDateDisabled: undefined,
  }
);

const model = defineModel<DateRange | null>({ default: null });
</script>

<template>
  <RangeCalendarRoot
    v-slot="{ grid, weekDays }"
    v-model="model"
    :is-date-disabled="isDateDisabled"
    initial-focus
    fixed-weeks
    :class="cn('bg-background group/calendar w-fit rounded-md border border-border p-3 [--cell-size:--spacing(8)]', props.class)"
  >
    <RangeCalendarHeader class="relative flex h-(--cell-size) items-center justify-center">
      <RangeCalendarPrev
        class="absolute left-0 inline-flex size-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50"
      >
        <UiIcon name="i-lucide-chevron-left" class="size-4" />
      </RangeCalendarPrev>
      <RangeCalendarHeading v-slot="{ headingValue }" class="select-none px-(--cell-size) text-sm font-medium">
        {{ headingValue }}
      </RangeCalendarHeading>
      <RangeCalendarNext
        class="absolute right-0 inline-flex size-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50"
      >
        <UiIcon name="i-lucide-chevron-right" class="size-4" />
      </RangeCalendarNext>
    </RangeCalendarHeader>

    <div class="mt-4 flex flex-col gap-4 md:flex-row">
      <RangeCalendarGrid v-for="month in grid" :key="month.value.toString()" class="w-full border-collapse">
        <RangeCalendarGridHead>
          <RangeCalendarGridRow class="flex">
            <RangeCalendarHeadCell
              v-for="day in weekDays"
              :key="day"
              class="flex-1 select-none rounded-md text-center text-[0.8rem] font-normal text-muted-foreground"
            >
              {{ day }}
            </RangeCalendarHeadCell>
          </RangeCalendarGridRow>
        </RangeCalendarGridHead>
        <RangeCalendarGridBody>
          <RangeCalendarGridRow v-for="(weekDates, index) in month.rows" :key="`week-${index}`" class="mt-2 flex w-full">
            <RangeCalendarCell
              v-for="date in weekDates"
              :key="date.toString()"
              :date="date"
              class="relative aspect-square h-full w-full p-0 text-center select-none"
            >
              <RangeCalendarCellTrigger
                v-slot="{ dayValue, today, outsideView, selected, highlighted, highlightedStart, highlightedEnd, selectionStart, selectionEnd }"
                :day="date"
                :month="month.value"
                :class="cn(
                  'flex aspect-square size-auto min-w-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm leading-none font-normal transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50',
                  today && !selected && !highlighted ? 'bg-accent text-accent-foreground' : '',
                  outsideView ? 'text-muted-foreground opacity-50' : '',
                  highlighted && !highlightedStart && !highlightedEnd ? 'rounded-none bg-accent text-accent-foreground' : '',
                  (selected || selectionStart || selectionEnd || highlightedStart || highlightedEnd) ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground' : '',
                  (selectionStart || highlightedStart) ? 'rounded-l-md' : '',
                  (selectionEnd || highlightedEnd) ? 'rounded-r-md' : '',
                )"
              >
                {{ dayValue }}
              </RangeCalendarCellTrigger>
            </RangeCalendarCell>
          </RangeCalendarGridRow>
        </RangeCalendarGridBody>
      </RangeCalendarGrid>
    </div>
  </RangeCalendarRoot>
</template>
