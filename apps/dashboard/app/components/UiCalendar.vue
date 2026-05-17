<script setup lang="ts">
import type { DateValue } from "reka-ui";
import {
  CalendarCell,
  CalendarCellTrigger,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHead,
  CalendarGridRow,
  CalendarHeadCell,
  CalendarHeader,
  CalendarHeading,
  CalendarNext,
  CalendarPrev,
  CalendarRoot,
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

const model = defineModel<DateValue | undefined>({ default: undefined });
</script>

<template>
  <CalendarRoot
    v-slot="{ grid, weekDays }"
    v-model="model"
    :is-date-disabled="isDateDisabled"
    initial-focus
    fixed-weeks
    :class="cn('bg-background group/calendar w-fit rounded-md border border-border p-3 [--cell-size:--spacing(8)]', props.class)"
  >
    <CalendarHeader class="relative flex h-(--cell-size) items-center justify-center">
      <CalendarPrev
        class="absolute left-0 inline-flex size-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50"
      >
        <UiIcon name="i-lucide-chevron-left" class="size-4" />
      </CalendarPrev>
      <CalendarHeading v-slot="{ headingValue }" class="select-none px-(--cell-size) text-sm font-medium">
        {{ headingValue }}
      </CalendarHeading>
      <CalendarNext
        class="absolute right-0 inline-flex size-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50"
      >
        <UiIcon name="i-lucide-chevron-right" class="size-4" />
      </CalendarNext>
    </CalendarHeader>

    <CalendarGrid v-for="month in grid" :key="month.value.toString()" class="mt-4 w-full border-collapse">
      <CalendarGridHead>
        <CalendarGridRow class="flex">
          <CalendarHeadCell
            v-for="day in weekDays"
            :key="day"
            class="flex-1 select-none rounded-md text-center text-[0.8rem] font-normal text-muted-foreground"
          >
            {{ day }}
          </CalendarHeadCell>
        </CalendarGridRow>
      </CalendarGridHead>
      <CalendarGridBody>
        <CalendarGridRow v-for="(weekDates, index) in month.rows" :key="`week-${index}`" class="mt-2 flex w-full">
          <CalendarCell
            v-for="date in weekDates"
            :key="date.toString()"
            :date="date"
            class="relative aspect-square h-full w-full p-0 text-center select-none"
          >
            <CalendarCellTrigger
              v-slot="{ dayValue, today, outsideView, selected }"
              :day="date"
              :month="month.value"
              :class="cn(
                'flex aspect-square size-auto min-w-(--cell-size) cursor-pointer items-center justify-center rounded-md text-sm leading-none font-normal transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:pointer-events-none disabled:opacity-50',
                today && !selected ? 'bg-accent text-accent-foreground' : '',
                outsideView ? 'text-muted-foreground opacity-50' : '',
                selected ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground' : '',
              )"
            >
              {{ dayValue }}
            </CalendarCellTrigger>
          </CalendarCell>
        </CalendarGridRow>
      </CalendarGridBody>
    </CalendarGrid>
  </CalendarRoot>
</template>
